import { ethers } from 'ethers';
import { program } from 'commander';
import * as dotenv from 'dotenv';
import { OrderType, UniswapXOrderCollector } from './collectors/uniswapxOrderCollector';
import { BlockCollector } from './collectors/blockCollector';
import { UniswapXRouteCollector } from './collectors/uniswapxRouteCollector';
import { UniswapXUniswapFill } from './strategies/uniswapxStrategy';
import { UniswapXPriorityFill } from './strategies/priorityStrategy';
import { ProtectExecutor } from './executors/protectExecutor';
import { Public1559Executor } from './executors/public1559Executor';

dotenv.config();

const MEV_BLOCKER = "https://rpc.mevblocker.io/noreverts";

async function main() {
    program
        .option('--wss <string>', 'Ethereum node WS endpoint')
        .option('--private-key <string>', 'Private key for sending txs')
        .option('--bid-percentage <number>', 'Percentage of profit to pay in gas', '90')
        .option('--executor-address <string>', 'Executor address')
        .option('--order-type <string>', 'Order type to use (Dutch_V2 or Priority)', 'Dutch_V2')
        .option('--chain-id <number>', 'Chain ID', '1');
    program.parse(process.argv);
    const options = program.opts();

    const wss = options.wss || process.env.WSS;
    const privateKey = options.privateKey || process.env.PRIVATE_KEY;
    const bidPercentage = parseInt(options.bidPercentage);
    const executorAddress = options.executorAddress || process.env.EXECUTOR_ADDRESS;
    const orderType = options.orderType as OrderType;
    const chainId = parseInt(options.chainId);

    if (!wss || !privateKey || !executorAddress) {
        console.error('Missing required options: --wss, --private-key, --executor-address');
        process.exit(1);
    }

    const provider = new ethers.providers.WebSocketProvider(wss);
    const mevBlockerProvider = new ethers.providers.JsonRpcProvider(MEV_BLOCKER);

    const wallet = new ethers.Wallet(privateKey, provider);
    const mevBlockerWallet = new ethers.Wallet(privateKey, mevBlockerProvider);

    const blockCollector = new BlockCollector(provider);
    const orderCollector = new UniswapXOrderCollector(chainId, orderType);
    const routeCollector = new UniswapXRouteCollector(chainId, executorAddress);

    const protectExecutor = new ProtectExecutor(provider, mevBlockerWallet);
    const public1559Executor = new Public1559Executor(provider, wallet);

    let strategy;
    const config = { executorAddress, bidPercentage };

    if (orderType === OrderType.DutchV2) {
        strategy = new UniswapXUniswapFill(provider, config, routeCollector);
    } else if (orderType === OrderType.Priority) {
        strategy = new UniswapXPriorityFill(provider, config, routeCollector);
    } else {
        console.error('Invalid order type');
        process.exit(1);
    }

    blockCollector.on('block', (block) => strategy.processNewBlock(block));
    orderCollector.on('order', (order) => strategy.processOrder(order));
    routeCollector.on('route', (route) => strategy.processNewRoute(route));

    strategy.on('action', (action) => {
        if (action.type === 'submitTx') {
            protectExecutor.execute(action);
        } else if (action.type === 'submitPublicTx') {
            public1559Executor.execute(action);
        }
    });

    blockCollector.start();
    orderCollector.start();

    console.log(`UniswapX Filler Bot started for ${orderType} orders on chain ${chainId}`);
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});