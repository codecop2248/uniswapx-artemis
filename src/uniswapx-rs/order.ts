import { BigNumber, ethers } from 'ethers';

// Based on the uniswapx-rs library
// THIS IS A REIMPLEMENTATION AND MAY CONTAIN ERRORS

export interface DutchOutput {
    token: string;
    startAmount: BigNumber;
    endAmount: BigNumber;
    recipient: string;
}

export interface DutchInput {
    token: string;
    startAmount: BigNumber;
    endAmount: BigNumber;
}

export interface V2DutchOrder {
    info: {
        offerer: string;
        nonce: BigNumber;
        deadline: number;
    };
    input: DutchInput;
    outputs: DutchOutput[];
}


export function decodeV2DutchOrder(encodedOrder: Buffer): V2DutchOrder {
    let offset = 0;

    const readAddress = () => {
        const address = '0x' + encodedOrder.slice(offset, offset + 20).toString('hex');
        offset += 20;
        return address;
    };

    const readUint256 = () => {
        const bn = BigNumber.from('0x' + encodedOrder.slice(offset, offset + 32).toString('hex'));
        offset += 32;
        return bn;
    };

    const readUint48 = () => {
        // Read 6 bytes for uint48
        const hex = '0x' + encodedOrder.slice(offset, offset + 6).toString('hex');
        offset += 6;
        return parseInt(hex, 16);
    };


    const offerer = readAddress();
    const nonce = readUint256();
    const deadline = readUint48();

    const inputToken = readAddress();
    const inputStartAmount = readUint256();
    const inputEndAmount = readUint256();

    const numOutputs = encodedOrder[offset];
    offset += 1;

    const outputs: DutchOutput[] = [];
    for (let i = 0; i < numOutputs; i++) {
        const token = readAddress();
        const startAmount = readUint256();
        const endAmount = readUint256();
        const recipient = readAddress();
        outputs.push({ token, startAmount, endAmount, recipient });
    }

    return {
        info: {
            offerer,
            nonce,
            deadline,
        },
        input: {
            token: inputToken,
            startAmount: inputStartAmount,
            endAmount: inputEndAmount,
        },
        outputs,
    };
}

export function encodeV2DutchOrder(order: V2DutchOrder): Buffer {
    const buffers: Buffer[] = [];

    const writeAddress = (address: string) => {
        buffers.push(Buffer.from(address.substring(2), 'hex'));
    };

    const writeUint256 = (bn: BigNumber) => {
        buffers.push(ethers.utils.arrayify(ethers.utils.hexZeroPad(bn.toHexString(), 32)));
    };

    const writeUint48 = (num: number) => {
        const hex = num.toString(16).padStart(12, '0');
        buffers.push(Buffer.from(hex, 'hex'));
    };

    writeAddress(order.info.offerer);
    writeUint256(order.info.nonce);
    writeUint48(order.info.deadline);

    writeAddress(order.input.token);
    writeUint256(order.input.startAmount);
    writeUint256(order.input.endAmount);

    buffers.push(Buffer.from([order.outputs.length]));

    for (const output of order.outputs) {
        writeAddress(output.token);
        writeUint256(output.startAmount);
        writeUint256(output.endAmount);
        writeAddress(output.recipient);
    }

    return Buffer.concat(buffers);
}

export interface PriorityOrder {
    info: {
        offerer: string;
        nonce: BigNumber;
        deadline: number;
    };
    inputToken: string;
    inputAmount: BigNumber;
    outputToken: string;
    outputAmount: BigNumber;
    priorityFee: BigNumber;
}

export function decodePriorityOrder(encodedOrder: Buffer): PriorityOrder {
    let offset = 0;

    const readAddress = () => {
        const address = '0x' + encodedOrder.slice(offset, offset + 20).toString('hex');
        offset += 20;
        return address;
    };

    const readUint256 = () => {
        const bn = BigNumber.from('0x' + encodedOrder.slice(offset, offset + 32).toString('hex'));
        offset += 32;
        return bn;
    };

    const readUint48 = () => {
        const hex = '0x' + encodedOrder.slice(offset, offset + 6).toString('hex');
        offset += 6;
        return parseInt(hex, 16);
    };

    const offerer = readAddress();
    const nonce = readUint256();
    const deadline = readUint48();
    const inputToken = readAddress();
    const inputAmount = readUint256();
    const outputToken = readAddress();
    const outputAmount = readUint256();
    const priorityFee = readUint256();

    return {
        info: {
            offerer,
            nonce,
            deadline,
        },
        inputToken,
        inputAmount,
        outputToken,
        outputAmount,
        priorityFee,
    };
}

export function encodePriorityOrder(order: PriorityOrder): Buffer {
    const buffers: Buffer[] = [];

    const writeAddress = (address: string) => {
        buffers.push(Buffer.from(address.substring(2), 'hex'));
    };

    const writeUint256 = (bn: BigNumber) => {
        buffers.push(ethers.utils.arrayify(ethers.utils.hexZeroPad(bn.toHexString(), 32)));
    };

    const writeUint48 = (num: number) => {
        const hex = num.toString(16).padStart(12, '0');
        buffers.push(Buffer.from(hex, 'hex'));
    };

    writeAddress(order.info.offerer);
    writeUint256(order.info.nonce);
    writeUint48(order.info.deadline);
    writeAddress(order.inputToken);
    writeUint256(order.inputAmount);
    writeAddress(order.outputToken);
    writeUint256(order.outputAmount);
    writeUint256(order.priorityFee);

    return Buffer.concat(buffers);
}