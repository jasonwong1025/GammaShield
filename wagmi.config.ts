import { defineConfig } from "@wagmi/cli";
import { foundry, react } from "@wagmi/cli/plugins";
import { erc20Abi } from "viem";

export default defineConfig({
  out: "lib/generated/contracts.ts",
  contracts: [{ name: "erc20", abi: erc20Abi }],
  plugins: [
    foundry({
      project: "./contracts",
      include: [
        "ShadowOptionBook.sol/ShadowOptionBook.json",
        "MandateAccount.sol/MandateAccount.json",
        "MandateAccount.sol/MandateAccountFactory.json",
      ],
    }),
    react(),
  ],
});
