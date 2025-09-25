import { ethers, BigNumber } from 'ethers';
import { ExecutionMetadata } from '../strategies/priorityStrategy';

export interface SubmitTxToMempoolWithExecutionMetadata {
    tx: ethers.PopulatedTransaction;
    metadata: ExecutionMetadata;
    gasBidInfo?: {
        bidPercentage: number;
    }
}

export class Public1559Executor {
    private client: ethers.providers.JsonRpcProvider;
    private senderClient: ethers.Wallet;

    constructor(client: ethers.providers.JsonRpcProvider, senderClient: ethers.Wallet) {
        this.client = client;
        this.senderClient = senderClient;
    }

    public async execute(action: SubmitTxToMempoolWithExecutionMetadata) {
        try {
            const gasUsage = await this.client.estimateGas(action.tx).catch(err => {
                console.error("Error estimating gas, using default", err);
                return BigNumber.from(1_000_000);
            });

            const baseFee = await this.client.getGasPrice();
            let maxPriorityFeePerGas: BigNumber | undefined;

            if (action.gasBidInfo) {
                maxPriorityFeePerGas = this.calculatePriorityFee(action.metadata, action.gasBidInfo.bidPercentage);
            } else {
                maxPriorityFeePerGas = BigNumber.from(50);
            }

            const tx = {
                ...action.tx,
                gasLimit: gasUsage,
                maxFeePerGas: baseFee,
                maxPriorityFeePerGas,
                type: 2,
            };

            console.log('Executing public 1559 tx:', tx);
            const response = await this.senderClient.sendTransaction(tx as any); // cast because of type difference
            console.log('Transaction sent:', response.hash);
        } catch (error) {
            console.error('Error executing public 1559 transaction:', error);
        }
    }

    private calculatePriorityFee(metadata: ExecutionMetadata, bidPercentage: number): BigNumber | undefined {
        const { quote, amountOutRequired } = metadata;
        if (quote.lte(amountOutRequired)) {
            return undefined;
        }
        const profitQuote = quote.sub(amountOutRequired);
        const mpsOfImprovement = profitQuote.mul(1000).div(amountOutRequired);
        return mpsOfImprovement.mul(bidPercentage).div(100);
    }
}