import { ethers, BigNumber } from 'ethers';

export interface GasBidInfo {
    bidPercentage: number;
    totalProfit: BigNumber;
}

export interface SubmitTxToMempool {
    tx: ethers.PopulatedTransaction;
    gasBidInfo?: GasBidInfo;
}

export class ProtectExecutor {
    private client: ethers.providers.JsonRpcProvider;
    private senderClient: ethers.Wallet;

    constructor(client: ethers.providers.JsonRpcProvider, senderClient: ethers.Wallet) {
        this.client = client;
        this.senderClient = senderClient;
    }

    public async execute(action: SubmitTxToMempool) {
        try {
            const gasUsage = await this.client.estimateGas(action.tx);
            let gasPrice: BigNumber;

            if (action.gasBidInfo) {
                const { totalProfit, bidPercentage } = action.gasBidInfo;
                const breakevenGasPrice = totalProfit.div(gasUsage);
                gasPrice = breakevenGasPrice.mul(bidPercentage).div(100);
            } else {
                gasPrice = await this.client.getGasPrice();
            }

            const tx = {
                ...action.tx,
                gasPrice,
                gasLimit: gasUsage,
            };

            console.log('Executing protected tx:', tx);
            const response = await this.senderClient.sendTransaction(tx);
            console.log('Transaction sent:', response.hash);
        } catch (error) {
            console.error('Error executing protected transaction:', error);
        }
    }
}