import axios from 'axios';
import { EventEmitter } from 'events';
import { BigNumber } from 'ethers';

const ROUTING_API = 'https://api.uniswap.org/v1/quote';
const SLIPPAGE_TOLERANCE = '0.5';
const DEADLINE = 1000;

export interface OrderData {
    order: any; // Ideally, we'd have a proper type for this
    hash: string;
    signature: string;
    resolved: any; // Ideally, we'd have a proper type for this
}

export interface OrderBatchData {
    orders: OrderData[];
    amountIn: BigNumber;
    amountOutRequired: BigNumber;
    tokenIn: string;
    tokenOut: string;
}

export interface OrderRoute {
    quote: string;
    quoteGasAdjusted: string;
    gasPriceWei: string;
    gasUseEstimateQuote: string;
    gasUseEstimate: string;
    route: any[];
    methodParameters: {
        calldata: string;
        value: string;
        to: string;
    };
}

export interface RoutedOrder {
    route: OrderRoute;
    request: OrderBatchData;
}

export class UniswapXRouteCollector extends EventEmitter {
    private client;
    private chainId: number;
    private executorAddress: string;

    constructor(chainId: number, executorAddress: string) {
        super();
        this.client = axios.create({
            headers: {
                origin: 'https://app.uniswap.org',
                'x-request-source': 'uniswap-web',
            }
        });
        this.chainId = chainId;
        this.executorAddress = executorAddress;
    }

    public async getRoute(batch: OrderBatchData): Promise<RoutedOrder | null> {
        try {
            const { tokenIn, tokenOut, amountIn } = batch;
            const query = {
                tokenInAddress: this.resolveAddress(tokenIn),
                tokenOutAddress: this.resolveAddress(tokenOut),
                tokenInChainId: this.chainId,
                tokenOutChainId: this.chainId,
                type: 'exactIn',
                amount: amountIn.toString(),
                recipient: this.executorAddress,
                slippageTolerance: SLIPPAGE_TOLERANCE,
                deadline: DEADLINE,
                enableUniversalRouter: false,
            };

            const queryString = new URLSearchParams(query as any).toString();
            const url = `${ROUTING_API}?${queryString}`;
            const response = await this.client.get<OrderRoute>(url);
            const route = response.data;

            const routedOrder = {
                route,
                request: batch,
            };
            this.emit('route', routedOrder);
            return routedOrder;
        } catch (error) {
            console.error('Error getting route:', error);
            return null;
        }
    }

    private resolveAddress(token: string): string {
        if (token === '0x0000000000000000000000000000000000000000') {
            return 'ETH';
        }
        return token;
    }
}