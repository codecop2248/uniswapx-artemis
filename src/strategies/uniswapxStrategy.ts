import { ethers, BigNumber } from 'ethers';
import { UniswapXOrder } from '../collectors/uniswapxOrderCollector';
import { NewBlock } from '../collectors/blockCollector';
import { OrderBatchData, OrderData, RoutedOrder, UniswapXRouteCollector } from '../collectors/uniswapxRouteCollector';
import { EventEmitter } from 'events';

import { decodeV2DutchOrder, V2DutchOrder } from '../uniswapx-rs/order';


const BLOCK_TIME = 12;
const DONE_EXPIRY = 300;
const REACTOR_ADDRESS = "0x00000011F84B9aa48e5f8aA8B9897600006289Be";
const WETH_ADDRESS = "0x4200000000000000000000000000000000000006"; // Example for a specific chain

interface Config {
    executorAddress: string;
    bidPercentage: number;
}

enum OrderStatus {
    Done,
    Open,
}

export class UniswapXUniswapFill extends EventEmitter {
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
        for (const batch of Object.values(batches)) {
            this.routeCollector.getRoute(batch);
        }
    }

    public async processNewRoute(routedOrder: RoutedOrder) {
        if (routedOrder.request.orders.some(o => this.doneOrders.has(o.hash))) {
            return;
        }

        const profit = this.getProfitEth(routedOrder);
        if (profit && profit.gt(0)) {
            console.log(`Sending trade: ${routedOrder.request.orders.length} orders, profit: ${profit.toString()} wei`);
            const signedOrders = this.getSignedOrders(routedOrder.request.orders);
            if (signedOrders) {
                const tx = await this.buildFill(this.client, this.executorAddress, signedOrders, routedOrder);
                this.emit('action', { type: 'submitTx', tx, gasBidInfo: { bidPercentage: this.bidPercentage, totalProfit: profit } });
            }
        }
    }

    private decodeOrder(encodedOrder: string): V2DutchOrder {
        const orderHex = Buffer.from(encodedOrder.startsWith('0x') ? encodedOrder.substring(2) : encodedOrder, 'hex');
        return decodeV2DutchOrder(orderHex);
    }

    private updateOrderState(order: V2DutchOrder, signature: string, orderHash: string) {
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

        // The `resolved` field is no longer needed as we can derive the amounts from the order itself
        this.openOrders.set(orderHash, {
            order,
            hash: orderHash,
            signature,
            resolved: {
                input: order.input,
                outputs: order.outputs,
            }
        });
    }

    private getOrderBatches(): { [key: string]: OrderBatchData } {
        const orderBatches: { [key: string]: OrderBatchData } = {};

        this.openOrders.forEach((orderData) => {
            const tokenIn = orderData.resolved.input.token;
            const tokenOut = orderData.resolved.outputs[0].token;
            const key = `${tokenIn}-${tokenOut}`;

            const amountIn = orderData.resolved.input.amount;
            const amountOut = orderData.resolved.outputs.reduce((sum: BigNumber, output: any) => sum.add(output.amount), BigNumber.from(0));

            if (!orderBatches[key]) {
                orderBatches[key] = {
                    orders: [orderData],
                    amountIn,
                    amountOutRequired: amountOut,
                    tokenIn,
                    tokenOut,
                };
            } else {
                const batch = orderBatches[key];
                batch.orders.push(orderData);
                batch.amountIn = batch.amountIn.add(amountIn);
                batch.amountOutRequired = batch.amountOutRequired.add(amountOut);
            }
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

    private getProfitEth(routedOrder: RoutedOrder): BigNumber | null {
        try {
            const quote = BigNumber.from(routedOrder.route.quote);
            const amountOutRequired = routedOrder.request.amountOutRequired;

            if (quote.lte(amountOutRequired)) {
                return null;
            }

            const profitQuote = quote.sub(amountOutRequired);

            if (routedOrder.request.tokenOut.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
                return profitQuote;
            }

            const gasUseEth = BigNumber.from(routedOrder.route.gasUseEstimate).mul(BigNumber.from(routedOrder.route.gasPriceWei));
            return profitQuote.mul(gasUseEth).div(BigNumber.from(routedOrder.route.gasUseEstimateQuote));
        } catch (e) {
            return null;
        }
    }

    private getSignedOrders(orders: OrderData[]): any[] | null {
        try {
            return orders.map(orderData => ({
                order: ethers.utils.hexlify(encodeV2DutchOrder(orderData.order)),
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
}