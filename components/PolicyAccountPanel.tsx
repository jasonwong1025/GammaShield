"use client";

import { useEffect, useState } from "react";
import { useAccount, useBytecode, useChainId, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { baseSepolia } from "wagmi/chains";
import { isAddress, zeroHash, type Address } from "viem";
import { mandateAccountFactoryAbi } from "@/lib/generated/contracts";
import { shortAddr } from "@/lib/format";
import { MandateSigningPanel } from "./MandateSigningPanel";

const factoryFromEnv = process.env.NEXT_PUBLIC_BASE_SEPOLIA_MANDATE_FACTORY_ADDRESS;
const FACTORY_ADDRESS: Address | undefined = factoryFromEnv && isAddress(factoryFromEnv) ? factoryFromEnv : undefined;
const EXPLORER_URL = process.env.NEXT_PUBLIC_BASE_SEPOLIA_EXPLORER_URL ?? "https://sepolia-explorer.base.org";

export function PolicyAccountPanel() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const [message, setMessage] = useState<string | null>(null);
  const canDerive = Boolean(address && FACTORY_ADDRESS);
  const { data: accountAddress, isPending: isDeriving, error: deriveError } = useReadAccountAddress(address);
  const { data: bytecode, refetch: refetchBytecode } = useBytecode({
    address: accountAddress,
    chainId: baseSepolia.id,
    query: { enabled: Boolean(accountAddress) },
  });
  const { writeContractAsync, data: transactionHash, isPending: isSubmitting } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    chainId: baseSepolia.id,
    hash: transactionHash,
  });

  useEffect(() => {
    if (!isSuccess) return;
    void refetchBytecode();
  }, [isSuccess, refetchBytecode]);

  const deployed = bytecode != null && bytecode !== "0x";
  const busy = isSwitching || isSubmitting || isConfirming;

  const createAccount = async () => {
    if (!address || !FACTORY_ADDRESS || deployed) return;
    setMessage(null);
    try {
      if (chainId !== baseSepolia.id) await switchChainAsync({ chainId: baseSepolia.id });
      await writeContractAsync({
        address: FACTORY_ADDRESS,
        abi: mandateAccountFactoryAbi,
        functionName: "createAccount",
        args: [address, zeroHash],
        chainId: baseSepolia.id,
      });
    } catch {
      setMessage("Account deployment was not completed.");
    }
  };

  return (
    <section className="card p-5 flex flex-col gap-4" aria-label="Policy account setup">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-blue">Base Sepolia · ERC-4337</p>
          <h2 className="mt-1 text-[16px] font-bold text-fg">Policy account</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">A dedicated smart account holds future test funds. An agent cannot use it until you register a bounded mandate.</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${deployed ? "bg-calm/15 text-calm" : "bg-panel2 text-muted"}`}>
          {deployed ? "Account deployed" : "Not deployed"}
        </span>
      </div>

      {!FACTORY_ADDRESS ? (
        <p className="rounded-lg border border-crit/30 bg-crit/10 p-3 text-[12px] text-crit">The Base Sepolia policy-account factory is not configured.</p>
      ) : !isConnected || !address ? (
        <p className="rounded-lg border border-edge bg-panel2 p-3 text-[12px] text-muted">Connect the wallet that will own this policy account.</p>
      ) : (
        <>
          <div className="grid gap-2 rounded-lg border border-edge bg-panel2 p-3 text-[12px] sm:grid-cols-[130px_1fr]">
            <span className="text-faint">Owner wallet</span>
            <span className="font-mono text-fg">{shortAddr(address)}</span>
            <span className="text-faint">Derived account</span>
            <span className="font-mono text-fg">{isDeriving ? "Deriving…" : accountAddress ? shortAddr(accountAddress) : "Unavailable"}</span>
          </div>

          {deriveError && <p className="text-[12px] text-crit">Could not derive the policy account on Base Sepolia.</p>}

          <div className="flex flex-wrap items-center gap-2">
            {deployed && accountAddress ? (
              <a href={`${EXPLORER_URL}/address/${accountAddress}`} target="_blank" rel="noopener noreferrer" className="h-9 rounded-lg bg-panel2 px-3 text-[12px] font-semibold text-blue hover:bg-panel3">
                View account ↗
              </a>
            ) : (
              <button type="button" onClick={() => void createAccount()} disabled={busy || isDeriving || !canDerive} className="h-9 rounded-lg bg-blue px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-60">
                {isSwitching ? "Switching network…" : isSubmitting ? "Confirm in wallet…" : isConfirming ? "Deploying account…" : "Create policy account"}
              </button>
            )}
            <span className="text-[11px] text-faint">This is a one-time wallet transaction; it does not enable autonomous trading.</span>
          </div>
          {deployed && accountAddress && <MandateSigningPanel owner={address} account={accountAddress} />}
        </>
      )}

      {(isSuccess || message) && <p className="rounded-lg border border-edge bg-panel2 p-3 text-[12px] text-muted">{isSuccess ? "Policy account deployed. It is unfunded and cannot execute until you register a mandate." : message}</p>}
    </section>
  );
}

function useReadAccountAddress(owner: Address | undefined) {
  return useReadContract({
    address: FACTORY_ADDRESS,
    abi: mandateAccountFactoryAbi,
    functionName: "getAddress",
    args: owner ? [owner, zeroHash] : undefined,
    chainId: baseSepolia.id,
    query: { enabled: Boolean(owner && FACTORY_ADDRESS) },
  });
}
