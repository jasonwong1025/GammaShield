import { readFile } from "node:fs/promises";
import { ethers } from "ethers";

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const rpcUrl = process.env.BASE_RPC_URL;
const privateKey = process.env.BASE_AGENT_PRIVATE_KEY;
if (!rpcUrl || !privateKey) throw new Error("set BASE_RPC_URL and BASE_AGENT_PRIVATE_KEY");

const artifact = JSON.parse(await readFile(new URL("../contracts/out/MandateAccount.sol/MandateAccountFactory.json", import.meta.url), "utf8"));
const provider = new ethers.JsonRpcProvider(rpcUrl);
const signer = new ethers.Wallet(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`, provider);
const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, signer);
const deployed = await factory.deploy(ENTRY_POINT, signer.address);
const receipt = await deployed.deploymentTransaction()?.wait();
if (!receipt) throw new Error("factory deployment receipt is unavailable");
console.log(JSON.stringify({ factory: await deployed.getAddress(), riskAttester: signer.address, block: receipt.blockNumber, transactionHash: receipt.hash }, null, 2));
