import { ethers, BigNumber } from 'ethers';
import { UniswapXOrder } from '../collectors/uniswapxOrderCollector';
import { NewBlock } from '../collectors/blockCollector';
import { OrderBatchData, OrderData, RoutedOrder, UniswapXRouteCollector } from '../collectors/uniswapxRouteCollector';
import { EventEmitter } from 'events';

import { decodePriorityOrder, PriorityOrder } from '../uniswapx-rs/order';

const BLOCK_TIME = 2;
const DONE_EXPIRY = 300;
const REACTOR_ADDRESS = "0x000000001Ec5656dcdB24D90DFa42742738De729";
const MPS = 1000;

interface Config {
    executorAddress: string;
    bidPercentage: number;
}

export interface ExecutionMetadata {
    quote: BigNumber;
    amountOutRequired: BigNumber;
}

export class UniswapXPriorityFill extends EventEmitter {
    private client: ethers.providers.JsonRpcProvider;
    private executorAddress: string;
    private bidPercentage: number;
    private lastBlockNumber: number = 0;
    private lastBlockTimestamp: number = 0;
    private openOrders: Map<string, OrderData> = new Map();
    private doneOrders: Map<string, number> = new Map();
    private routeCollector: UniswapXRouteCollector;

    constructor(client: ethers.providers.JsonRpcProvider, config: Config, routeCollector: UniswapXRouteCollector) {
        super();
        this.client = client;
        this.executorAddress = config.executorAddress;
        this.bidPercentage = config.bidPercentage;
        this.routeCollector = routeCollector;
    }

    public async processOrder(order: UniswapXOrder) {
        if (this.lastBlockTimestamp === 0) return;

        try {
            const decodedOrder = this.decodeOrder(order.encodedOrder);
            this.updateOrderState(decodedOrder, order.signature, order.orderHash);
            const batches = this.getOrderBatches();
            for (const batch of batches) {
                this.routeCollector.getRoute(batch);
            }
        } catch (error) {
            console.error('Failed to decode order:', error);
        }
    }

    public async processNewBlock(block: NewBlock) {
        this.lastBlockNumber = block.number;
        this.lastBlockTimestamp = block.timestamp;

        console.log(`Processing block ${block.number} at ${block.timestamp}, Orders - open: ${this.openOrders.size}, done: ${this.doneOrders.size}`);

        await this.handleFills();
        this.updateOpenOrders();
        this.pruneDoneOrders();

        const batches = this.getOrderBatches();
        for (const batch of batches) {
            this.routeCollector.getRoute(batch);
        }
    }

    public async processNewRoute(routedOrder: RoutedOrder) {
        if (routedOrder.request.orders.some(o => this.doneOrders.has(o.hash))) {
            return;
        }

        const metadata = this.getExecutionMetadata(routedOrder);
        if (metadata) {
            console.log(`Sending trade: ${routedOrder.request.orders.length} orders`);
            const signedOrders = this.getSignedOrders(routedOrder.request.orders);
            if (signedOrders) {
                const tx = await this.buildFill(this.client, this.executorAddress, signedOrders, routedOrder);
                this.emit('action', { type: 'submitPublicTx', tx, metadata, gasBidInfo: { bidPercentage: this.bidPercentage } });
            }
        }
    }

    private decodeOrder(encodedOrder: string): PriorityOrder {
        const orderHex = Buffer.from(encodedOrder.startsWith('0x') ? encodedOrder.substring(2) : encodedOrder, 'hex');
        return decodePriorityOrder(orderHex);
    }

    private updateOrderState(order: PriorityOrder, signature: string, orderHash: string) {
        const now = this.lastBlockTimestamp + BLOCK_TIME;
        if (order.info.deadline < now) {
            this.markAsDone(orderHash);
            return;
        }

        if (this.doneOrders.has(orderHash)) {
            console.log(`Order already done, skipping: ${orderHash}`);
            return;
        }
        if (!this.openOrders.has(orderHash)) {
            console.log(`Adding new order ${orderHash}`);
        }
        this.openOrders.set(orderHash, {
            order,
            hash: orderHash,
            signature,
            resolved: {
                input: { token: order.inputToken, amount: order.inputAmount },
                outputs: [{ token: order.outputToken, amount: order.outputAmount }]
            }
        });
    }

    private getOrderBatches(): OrderBatchData[] {
        const orderBatches: OrderBatchData[] = [];
        this.openOrders.forEach((orderData) => {
            const amountIn = orderData.resolved.input.amount;
            const amountOut = orderData.resolved.outputs.reduce((sum: BigNumber, output: any) => sum.add(output.amount), BigNumber.from(0));
            orderBatches.push({
                orders: [orderData],
                amountIn,
                amountOutRequired: amountOut,
                tokenIn: orderData.resolved.input.token,
                tokenOut: orderData.resolved.outputs[0].token,
            });
        });
        return orderBatches;
    }

    private async handleFills() {
        const filter = {
            address: REACTOR_ADDRESS,
            fromBlock: this.lastBlockNumber,
            toBlock: this.lastBlockNumber,
            topics: [ethers.utils.id("Fill(bytes32,address,address,uint256)")]
        };
        const logs = await this.client.getLogs(filter);
        logs.forEach(log => {
            const orderHash = log.topics[1];
            console.log(`Removing filled order ${orderHash}`);
            this.openOrders.delete(orderHash);
            this.doneOrders.set(orderHash, this.lastBlockTimestamp + DONE_EXPIRY);
        });
    }

    private getExecutionMetadata(routedOrder: RoutedOrder): ExecutionMetadata | null {
        try {
            const quote = BigNumber.from(routedOrder.route.quote);
            const amountOutRequired = routedOrder.request.amountOutRequired;

            if (quote.lte(amountOutRequired)) {
                return null;
            }
            return { quote, amountOutRequired };
        } catch (e) {
            return null;
        }
    }

    private calculatePriorityFee(metadata: ExecutionMetadata, bidPercentage: number): BigNumber | null {
        const { quote, amountOutRequired } = metadata;
        if (quote.lte(amountOutRequired)) {
            return null;
        }
        const profitQuote = quote.sub(amountOutRequired);
        const mpsOfImprovement = profitQuote.mul(MPS).div(amountOutRequired);
        return mpsOfImprovement.mul(bidPercentage).div(100);
    }

    private getSignedOrders(orders: OrderData[]): any[] | null {
        try {
            return orders.map(orderData => ({
                order: ethers.utils.hexlify(encodePriorityOrder(orderData.order)),
                sig: orderData.signature
            }));
        } catch (e) {
            return null;
        }
    }

    private async buildFill(client: ethers.providers.Provider, executorAddress: string, signedOrders: any[], routedOrder: RoutedOrder): Promise<ethers.PopulatedTransaction> {
        const reactorInterface = new ethers.utils.Interface([
            "function execute((address,bytes)[],bytes,address,uint256)"
        ]);

        const calldata = reactorInterface.encodeFunctionData("execute", [
            signedOrders,
            routedOrder.route.methodParameters.calldata,
            this.executorAddress,
            routedOrder.request.amountOutRequired
        ]);

        return {
            to: REACTOR_ADDRESS,
            data: calldata,
            from: executorAddress,
            value: routedOrder.route.methodParameters.value,
        };
    }

    private pruneDoneOrders() {
        const toRemove: string[] = [];
        this.doneOrders.forEach((deadline, orderHash) => {
            if (deadline < this.lastBlockTimestamp) {
                toRemove.push(orderHash);
            }
        });
        toRemove.forEach(hash => this.doneOrders.delete(hash));
    }

    private updateOpenOrders() {
        this.openOrders.forEach((orderData, orderHash) => {
            this.updateOrderState(orderData.order, orderData.signature, orderHash);
        });
    }

    private markAsDone(orderHash: string) {
        this.openOrders.delete(orderHash);
        if (!this.doneOrders.has(orderHash)) {
            this.doneOrders.set(orderHash, this.lastBlockTimestamp + DONE_EXPIRY);
        }
    }
}