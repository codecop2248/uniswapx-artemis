import { ethers } from 'ethers';
import { EventEmitter } from 'events';

export interface NewBlock {
    number: number;
    timestamp: number;
}

export class BlockCollector extends EventEmitter {
    private provider: ethers.providers.JsonRpcProvider;
    private lastBlockNumber: number = 0;

    constructor(provider: ethers.providers.JsonRpcProvider) {
        super();
        this.provider = provider;
    }

    public start() {
        this.provider.on('block', async (blockNumber) => {
            if (blockNumber > this.lastBlockNumber) {
                this.lastBlockNumber = blockNumber;
                const block = await this.provider.getBlock(blockNumber);
                this.emit('block', {
                    number: block.number,
                    timestamp: block.timestamp,
                });
            }
        });
    }

    public stop() {
        this.provider.off('block');
    }
}