// Deploys the Base Sepolia demo stack: the shadow receipt book and the policy
// account factory. Both have to be redeployed together for Auto-Close and
// Auto-Roll, because the close path spans them — ShadowOptionBook gained
// closeShadow, and MandateAccount gained executeShadowClose/executeShadowRoll.
//
// Run `cd contracts && forge build` first, then set the printed addresses in
// .env.local. Until they are set, the app reports closing and rolling as
// unavailable rather than pretending they work.

import { readFile } from "node:fs/promises";
import { ethers } from "ethers";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
const privateKey = process.env.SHADOW_QUOTE_SIGNER_PRIVATE_KEY;
const usdc = process.env.SHADOW_USDC_ADDRESS;
if (!rpcUrl || !privateKey || !usdc) throw new Error("set BASE_SEPOLIA_RPC_URL, SHADOW_QUOTE_SIGNER_PRIVATE_KEY and SHADOW_USDC_ADDRESS");
if (!ethers.isAddress(usdc)) throw new Error("SHADOW_USDC_ADDRESS is not an address");

const load = async (name) =>
  JSON.parse(await readFile(new URL(`../contracts/out/${name}`, import.meta.url), "utf8"));

const provider = new ethers.JsonRpcProvider(rpcUrl, 84532, { staticNetwork: true });
const signer = new ethers.Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`, provider);

const bookArtifact = await load("ShadowOptionBook.sol/ShadowOptionBook.json");
const book = await new ethers.ContractFactory(bookArtifact.abi, bookArtifact.bytecode.object, signer).deploy(usdc, signer.address);
const bookReceipt = await book.deploymentTransaction()?.wait();
if (!bookReceipt) throw new Error("shadow book deployment receipt is unavailable");

const factoryArtifact = await load("MandateAccount.sol/MandateAccountFactory.json");
const factory = await new ethers.ContractFactory(factoryArtifact.abi, factoryArtifact.bytecode.object, signer).deploy(ENTRY_POINT, signer.address);
const factoryReceipt = await factory.deploymentTransaction()?.wait();
if (!factoryReceipt) throw new Error("factory deployment receipt is unavailable");

const bookAddress = await book.getAddress();
console.log(JSON.stringify({
  SHADOW_OPTION_BOOK_ADDRESS: bookAddress,
  NEXT_PUBLIC_BASE_SEPOLIA_SHADOW_OPTION_BOOK_ADDRESS: bookAddress,
  SHADOW_DEPLOYMENT_BLOCK: bookReceipt.blockNumber,
  NEXT_PUBLIC_BASE_SEPOLIA_MANDATE_FACTORY_ADDRESS: await factory.getAddress(),
  BASE_SEPOLIA_MANDATE_FACTORY_DEPLOYMENT_BLOCK: factoryReceipt.blockNumber,
  attester: signer.address,
  shadowBookVersion: Number(await book.version()),
}, null, 2));
console.error("\nThe new book starts with no collateral. Fund it with test USDC before the agent can pay out an exit.");
