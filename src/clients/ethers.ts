import { ethers } from "ethers";
import { config } from "../config";

const slsPayerAbi = [
  "function pay(uint256 amount, uint16 slsShareBps, bool increaseSLS, uint256 additionalEva) external",
  "function backingToken() view returns (address)",
  "function burnVault() view returns (address)",
];

const factoryAbi = ["function activeVault() view returns (address)"];

export function getProvider() {
  return new ethers.JsonRpcProvider(config.rpcUrl, config.chainId);
}

export function getWallet(provider = getProvider()) {
  return new ethers.Wallet(config.payerPrivateKey, provider);
}

export function getSlsPayerContract(providerOrSigner = getWallet()) {
  return new ethers.Contract(config.contract.slsPayer, slsPayerAbi, providerOrSigner);
}

export function getFactoryContract(providerOrSigner = getWallet()) {
  return new ethers.Contract(config.contract.factory, factoryAbi, providerOrSigner);
}

