"use client";

import { useEffect, useState } from "react";
import { useAccount, useBalance, useBytecode, useChainId, useReadContract, useSendTransaction, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { baseSepolia } from "wagmi/chains";
import { formatEther, formatUnits, isAddress, parseEther, parseUnits, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { erc20Abi, mandateAccountFactoryAbi, useReadErc20BalanceOf } from "@/lib/generated/contracts";
import { shortAddr } from "@/lib/format";
import { wagmiConfig } from "@/lib/wagmi";
import { MandateSigningPanel } from "./MandateSigningPanel";

const factoryFromEnv = process.env.NEXT_PUBLIC_BASE_SEPOLIA_MANDATE_FACTORY_ADDRESS;
const FACTORY_ADDRESS: Address | undefined = factoryFromEnv && isAddress(factoryFromEnv) ? factoryFromEnv : undefined;
const EXPLORER_URL = process.env.NEXT_PUBLIC_BASE_SEPOLIA_EXPLORER_URL ?? "https://sepolia-explorer.base.org";
const usdcFromEnv = process.env.NEXT_PUBLIC_BASE_SEPOLIA_SHADOW_USDC_ADDRESS;
const SHADOW_USDC: Address | undefined = usdcFromEnv && isAddress(usdcFromEnv) ? usdcFromEnv : undefined;

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
          {deployed && accountAddress && <PolicyFundingPanel account={accountAddress} />}
        </>
      )}

      {(isSuccess || message) && <p className="rounded-lg border border-edge bg-panel2 p-3 text-[12px] text-muted">{isSuccess ? "Policy account deployed. It is unfunded and cannot execute until you register a mandate." : message}</p>}
    </section>
  );
}

function PolicyFundingPanel({ account }: { account: Address }) {
  const { address: owner, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const [ethAmount, setEthAmount] = useState("0.001");
  const [usdcAmount, setUsdcAmount] = useState("5");
  const [status, setStatus] = useState<{ kind: "idle" | "pending" | "success" | "error"; message?: string }>({ kind: "idle" });
  const { data: ethBalance, refetch: refetchEth } = useBalance({
    address: account,
    chainId: baseSepolia.id,
  });
  const { data: usdcBalance, refetch: refetchUsdc } = useReadErc20BalanceOf({
    address: SHADOW_USDC ?? zeroAddress,
    args: [account],
    chainId: baseSepolia.id,
    query: { enabled: Boolean(SHADOW_USDC) },
  });

  const fund = async (asset: "ETH" | "USDC") => {
    if (!owner || status.kind === "pending") return;
    setStatus({ kind: "pending", message: asset === "ETH" ? "Confirm ETH transfer in wallet…" : "Confirm test USDC transfer in wallet…" });
    try {
      if (chainId !== baseSepolia.id) await switchChainAsync({ chainId: baseSepolia.id });
      let hash: Hex;
      if (asset === "ETH") {
        hash = await sendTransactionAsync({
          chainId: baseSepolia.id,
          to: account,
          value: positiveAmount(ethAmount, 18, "ETH"),
        });
      } else {
        if (!SHADOW_USDC) throw new Error("The Base Sepolia test USDC address is not configured.");
        hash = await writeContractAsync({
          address: SHADOW_USDC,
          abi: erc20Abi,
          functionName: "transfer",
          args: [account, positiveAmount(usdcAmount, 6, "test USDC")],
          chainId: baseSepolia.id,
        });
      }
      setStatus({ kind: "pending", message: "Waiting for Base Sepolia confirmation…" });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: baseSepolia.id, hash });
      if (receipt.status !== "success") throw new Error("The transfer reverted on-chain.");
      await Promise.all([refetchEth(), refetchUsdc()]);
      setStatus({ kind: "success", message: `${asset} funding confirmed.` });
    } catch (error) {
      setStatus({ kind: "error", message: error instanceof Error && error.message.startsWith("The Base Sepolia") ? error.message : "Funding was not completed. No funds moved." });
    }
  };

  const busy = status.kind === "pending";
  return (
    <section className="mt-4 border-t border-edge pt-4" aria-label="Fund policy account">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-blue">Step 3 · Funding</p>
      <h3 className="mt-1 text-[14px] font-bold text-fg">Fund policy account</h3>
      <p className="mt-1 text-[12px] text-muted">Transfers go directly from your connected wallet to this fixed policy account. ETH pays UserOperation gas; test USDC is the bounded trade collateral.</p>

      <div className="mt-3 grid gap-2 rounded-lg border border-edge bg-panel2 p-3 text-[11px] sm:grid-cols-[110px_1fr]">
        <span className="text-faint">Recipient</span><span className="font-mono text-fg" title={account}>{shortAddr(account)}</span>
        <span className="text-faint">Current balance</span><span className="text-fg">{ethBalance ? `${displayAmount(formatEther(ethBalance.value))} ETH` : "… ETH"} · {usdcBalance != null ? `${displayAmount(formatUnits(usdcBalance, 6))} test USDC` : "… test USDC"}</span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <FundingField label="Base Sepolia ETH" value={ethAmount} onChange={setEthAmount} button="Fund ETH" disabled={busy} onFund={() => void fund("ETH")} />
        <FundingField label="Base Sepolia test USDC" value={usdcAmount} onChange={setUsdcAmount} button="Fund USDC" disabled={busy || !SHADOW_USDC} onFund={() => void fund("USDC")} />
      </div>
      <p className="mt-2 text-[11px] text-faint">Each transfer has its own wallet confirmation. USDC is transferred directly—there is no approval or spending allowance.</p>
      {status.kind !== "idle" && <p className={`mt-3 rounded-lg border p-3 text-[12px] ${status.kind === "error" ? "border-crit/30 bg-crit/10 text-crit" : status.kind === "success" ? "border-calm/30 bg-calm/10 text-calm" : "border-edge bg-panel2 text-muted"}`}>{status.message}</p>}
    </section>
  );
}

function FundingField({ label, value, onChange, button, disabled, onFund }: { label: string; value: string; onChange: (value: string) => void; button: string; disabled: boolean; onFund: () => void }) {
  return (
    <label className="rounded-lg border border-edge bg-panel2 p-3 text-[12px] text-muted">
      <span>{label}</span>
      <input type="text" inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 h-9 w-full rounded-md border border-edge bg-panel px-2 font-mono text-fg outline-none focus:border-blue" aria-label={`${label} funding amount`} />
      <button type="button" onClick={onFund} disabled={disabled} className="mt-2 h-8 rounded-lg bg-blue px-3 text-[11px] font-semibold text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-60">{button}</button>
    </label>
  );
}

function positiveAmount(value: string, decimals: number, label: string): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Enter a valid ${label} amount.`);
  const amount = decimals === 18 ? parseEther(value) : parseUnits(value, decimals);
  if (amount <= 0n) throw new Error(`Enter a positive ${label} amount.`);
  return amount;
}

function displayAmount(value: string) {
  const [whole, fraction] = value.split(".");
  const trimmed = fraction?.slice(0, 6).replace(/0+$/, "");
  return trimmed ? `${whole}.${trimmed}` : whole;
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
