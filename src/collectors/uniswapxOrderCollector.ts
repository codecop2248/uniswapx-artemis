import axios from 'axios';
import { EventEmitter } from 'events';

const UNISWAPX_API_URL = 'https://api.uniswap.org/v2';
const POLL_INTERVAL_SECS = 1;

export enum OrderType {
    DutchV2 = 'Dutch_V2',
    Priority = 'Priority',
}

export interface UniswapXOrder {
    encodedOrder: string;
    signature: string;
    orderStatus: string;
    createdAt: number;
    chainId: number;
    orderHash: string;
}

export interface UniswapXOrderResponse {
    orders: UniswapXOrder[];
}

export class UniswapXOrderCollector extends EventEmitter {
    private client;
    private baseUrl: string;
    private chainId: number;
    private orderType: OrderType;
    private interval: NodeJS.Timeout | null = null;

    constructor(chainId: number, orderType: OrderType) {
        super();
        this.client = axios.create();
        this.baseUrl = UNISWAPX_API_URL;
        this.chainId = chainId;
        this.orderType = orderType;
    }

    public start() {
        this.interval = setInterval(() => this.poll(), POLL_INTERVAL_SECS * 1000);
    }

    public stop() {
        if (this.interval) {
            clearInterval(this.interval);
        }
    }

    private async poll() {
        try {
            const url = `${this.baseUrl}/orders?orderStatus=open&chainId=${this.chainId}&orderType=${this.orderType}`;
            const response = await this.client.get<UniswapXOrderResponse>(url);
            const orders = response.data.orders;
            for (const order of orders) {
                this.emit('order', order);
            }
        } catch (error) {
            console.error('Error polling for orders:', error);
        }
    }
}