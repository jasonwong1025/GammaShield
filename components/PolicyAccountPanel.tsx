"use client";

import { useEffect, useState } from "react";
import { useAccount, useBalance, useBytecode, useReadContract, useSendTransaction, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { formatEther, formatUnits, parseEther, parseUnits, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { erc20Abi, mandateAccountAbi, mandateAccountFactoryAbi, useReadErc20BalanceOf } from "@/lib/generated/contracts";
import { shortAddr } from "@/lib/format";
import { wagmiConfig } from "@/lib/wagmi";
import { MandateSigningPanel } from "./MandateSigningPanel";
import { AgentMonitoringPanel } from "./AgentMonitoringPanel";
import { ExplorerLink } from "./ExplorerLink";
import { useExecutionNetwork } from "./ExecutionNetworkProvider";
import { policyNetwork } from "@/lib/policyNetwork";
import { ensureWalletChain, walletActionError } from "@/lib/walletChain";

export function PolicyAccountPanel({ spot }: { spot: number }) {
  const { network } = useExecutionNetwork();
  const policy = policyNetwork(network);
  const { address, connector, isConnected } = useAccount();
  const { switchChainAsync, isPending: isSwitching } = useSwitchChain();
  const [message, setMessage] = useState<string | null>(null);
  const canDerive = Boolean(address && policy.factory);
  const { data: accountAddress, isPending: isDeriving, error: deriveError } = useReadAccountAddress(address, policy.factory, policy.chainId);
  const { data: bytecode, error: bytecodeError, isPending: isCheckingDeployment, refetch: refetchBytecode } = useBytecode({
    address: accountAddress,
    chainId: policy.chainId,
    query: { enabled: Boolean(accountAddress) },
  });
  const { writeContractAsync, data: transactionHash, isPending: isSubmitting } = useWriteContract();
  const { isError: deploymentFailed, error: deploymentError, isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    chainId: policy.chainId,
    hash: transactionHash,
  });

  useEffect(() => {
    if (!isSuccess) return;
    void refetchBytecode();
  }, [isSuccess, refetchBytecode]);

  const deployed = bytecode != null && bytecode !== "0x";
  const { data: activeMandateHash } = useReadContract({
    address: accountAddress,
    abi: mandateAccountAbi,
    functionName: "activeMandateHash",
    chainId: policy.chainId,
    query: { enabled: deployed && Boolean(accountAddress) },
  });
  const activeMandate = activeMandateHash && activeMandateHash !== zeroHash ? activeMandateHash : null;
  const accountStateUnknown = Boolean(bytecodeError);
  const deploymentMessage = deploymentFailed
    ? `The deployment transaction did not succeed on-chain: ${walletActionError(deploymentError, "check the linked transaction before retrying.")} No policy account was created; network gas may have been charged.`
    : message;
  const busy = isSwitching || isSubmitting || isConfirming;

  const createAccount = async () => {
    if (!address || !policy.factory || deployed) return;
    setMessage(null);
    try {
      await ensureWalletChain(policy.chainId, connector, switchChainAsync);
      await writeContractAsync({
        address: policy.factory,
        abi: mandateAccountFactoryAbi,
        functionName: "createAccount",
        args: [address, zeroHash],
        chainId: policy.chainId,
      });
    } catch (error) {
      setMessage(`Account deployment was not completed: ${walletActionError(error, "the wallet did not submit a transaction.")}`);
    }
  };

  return (
    <section className="card p-5 flex flex-col gap-4" aria-label="Policy account setup">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-blue">{network === "mainnet" ? "Base mainnet" : "Base Sepolia"} · ERC-4337</p>
          <h2 className="mt-1 text-[16px] font-bold text-fg">Policy account</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-muted">A dedicated smart account holds policy funds. An agent cannot use it until you register a bounded mandate.</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ${deployed ? "bg-calm/15 text-calm" : "bg-panel2 text-muted"}`}>
          {deployed ? "Account deployed" : "Not deployed"}
        </span>
      </div>

      {!policy.factory || !policy.agent ? (
        <p className="rounded-lg border border-crit/30 bg-crit/10 p-3 text-[12px] text-crit">The {network === "mainnet" ? "Base-mainnet" : "Base Sepolia"} policy-account factory or agent is not configured.</p>
      ) : !isConnected || !address ? (
        <p className="rounded-lg border border-edge bg-panel2 p-3 text-[12px] text-muted">Connect the wallet that will own this policy account.</p>
      ) : (
        <>
          <div className="grid gap-2 rounded-lg border border-edge bg-panel2 p-3 text-[12px] sm:grid-cols-[130px_1fr]">
            <span className="text-faint">Owner wallet</span>
            <ExplorerLink network={network} resource="address" value={address} className="font-mono text-fg hover:text-blue">{shortAddr(address)}</ExplorerLink>
            <span className="text-faint">Derived account</span>
            {accountAddress ? <ExplorerLink network={network} resource="address" value={accountAddress} className="font-mono text-fg hover:text-blue">{shortAddr(accountAddress)}</ExplorerLink> : <span className="font-mono text-fg">{isDeriving ? "Deriving…" : "Unavailable"}</span>}
          </div>

          {deriveError && <p className="text-[12px] text-crit">Could not derive the policy account on {network === "mainnet" ? "Base mainnet" : "Base Sepolia"}.</p>}
          {accountAddress && isCheckingDeployment && <p className="text-[12px] text-muted">Checking whether the deterministic policy account is already deployed…</p>}
          {accountStateUnknown && <p className="text-[12px] text-crit">Could not verify whether this policy account is deployed. Reload or restore the Base RPC connection before submitting another deployment.</p>}

          <div className="flex flex-wrap items-center gap-2">
            {deployed && accountAddress ? (
              <ExplorerLink network={network} resource="address" value={accountAddress} className="h-9 rounded-lg bg-panel2 px-3 text-[12px] font-semibold text-blue hover:bg-panel3">
                View account ↗
              </ExplorerLink>
            ) : (
              <button type="button" onClick={() => void createAccount()} disabled={busy || isDeriving || isCheckingDeployment || !canDerive || accountStateUnknown} className="h-9 rounded-lg bg-blue px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-60">
                {isSwitching ? "Switching network…" : isSubmitting ? "Confirm in wallet…" : isConfirming ? "Deploying account…" : "Create policy account"}
              </button>
            )}
            <span className="text-[11px] text-faint">This is a one-time wallet transaction; it does not enable autonomous trading.</span>
          </div>
          {isConfirming && transactionHash && <p className="rounded-lg border border-edge bg-panel2 p-3 text-[12px] text-muted">Deployment transaction submitted; awaiting Base confirmation. <ExplorerLink network={network} resource="tx" value={transactionHash} className="underline">View transaction</ExplorerLink></p>}
          {deployed && accountAddress && <MandateSigningPanel owner={address} account={accountAddress} network={network} spot={spot} />}
          {deployed && accountAddress && <PolicyFundingPanel account={accountAddress} network={network} collateral={policy.collateral} collateralLabel={policy.collateralLabel} chainId={policy.chainId} />}
          {deployed && accountAddress && activeMandate && <AgentMonitoringPanel account={accountAddress} mandateHash={activeMandate} network={network} />}
        </>
      )}

      {(isSuccess || deploymentMessage) && <p className="rounded-lg border border-edge bg-panel2 p-3 text-[12px] text-muted">{isSuccess ? <>Policy account deployed. A registered mandate and sufficient ETH/USDC are required before agent actions are eligible. {transactionHash && <ExplorerLink network={network} resource="tx" value={transactionHash} className="text-blue hover:underline">View deployment</ExplorerLink>}</> : deploymentMessage}</p>}
    </section>
  );
}

function PolicyFundingPanel({ account, network, collateral, collateralLabel, chainId: targetChainId }: { account: Address; network: "mainnet" | "sepolia"; collateral: Address | undefined; collateralLabel: string; chainId: 8453 | 84532 }) {
  const { address: owner, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const [ethAmount, setEthAmount] = useState("0.001");
  const [usdcAmount, setUsdcAmount] = useState("5");
  const [status, setStatus] = useState<{ kind: "idle" | "pending" | "success" | "error"; message?: string; hash?: Hex }>({ kind: "idle" });
  const { data: ethBalance, refetch: refetchEth } = useBalance({
    address: account,
    chainId: targetChainId,
  });
  const { data: usdcBalance, refetch: refetchUsdc } = useReadErc20BalanceOf({
    address: collateral ?? zeroAddress,
    args: [account],
    chainId: targetChainId,
    query: { enabled: Boolean(collateral) },
  });

  const fund = async (asset: "ETH" | "USDC") => {
    if (!owner || status.kind === "pending") return;
    let hash: Hex | undefined;
    let receiptRead = false;
    setStatus({ kind: "pending", message: asset === "ETH" ? "Confirm ETH transfer in wallet…" : `Confirm ${collateralLabel} transfer in wallet…` });
    try {
      await ensureWalletChain(targetChainId, connector, switchChainAsync);
      if (asset === "ETH") {
        hash = await sendTransactionAsync({
          chainId: targetChainId,
          to: account,
          value: positiveAmount(ethAmount, 18, "ETH"),
        });
      } else {
        if (!collateral) throw new Error(`The ${network === "mainnet" ? "Base-mainnet" : "Base Sepolia"} USDC address is not configured.`);
        hash = await writeContractAsync({
          address: collateral,
          abi: erc20Abi,
          functionName: "transfer",
          args: [account, positiveAmount(usdcAmount, 6, collateralLabel)],
          chainId: targetChainId,
        });
      }
      setStatus({ kind: "pending", message: `Waiting for ${network === "mainnet" ? "Base mainnet" : "Base Sepolia"} confirmation…` });
      const receipt = await waitForTransactionReceipt(wagmiConfig, { chainId: targetChainId, hash });
      receiptRead = true;
      if (receipt.status !== "success") throw new Error("The transfer reverted on-chain.");
      await Promise.all([refetchEth(), refetchUsdc()]).catch(() => undefined);
      setStatus({ kind: "success", message: `${asset} funding confirmed.`, hash });
    } catch (error) {
      setStatus({
        kind: "error",
        hash,
        message: hash && !receiptRead
          ? "Funding transaction was submitted, but confirmation could not be read. Check the linked transaction before retrying."
          : hash
            ? "Funding transaction reverted on-chain. No funds were transferred; network gas may have been charged."
            : `Funding was not completed: ${walletActionError(error, "the wallet did not submit a transaction.")}`,
      });
    }
  };

  const busy = status.kind === "pending";
  return (
    <section className="mt-4 border-t border-edge pt-4" aria-label="Fund policy account">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-blue">Step 3 · Funding</p>
      <h3 className="mt-1 text-[14px] font-bold text-fg">Fund policy account</h3>
      <p className="mt-1 text-[12px] text-muted">Transfers go directly from your connected wallet to this fixed policy account. ETH pays UserOperation gas; {collateralLabel} is the bounded trade collateral.</p>

      <div className="mt-3 grid gap-2 rounded-lg border border-edge bg-panel2 p-3 text-[11px] sm:grid-cols-[110px_1fr]">
        <span className="text-faint">Recipient</span><ExplorerLink network={network} resource="address" value={account} className="font-mono text-fg hover:text-blue">{shortAddr(account)}</ExplorerLink>
        <span className="text-faint">Current balance</span><span className="text-fg">{ethBalance ? `${displayAmount(formatEther(ethBalance.value))} ETH` : "… ETH"} · {usdcBalance != null ? `${displayAmount(formatUnits(usdcBalance, 6))} ${collateralLabel}` : `… ${collateralLabel}`}</span>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <FundingField label={`${network === "mainnet" ? "Base" : "Base Sepolia"} ETH`} value={ethAmount} onChange={setEthAmount} button="Fund ETH" disabled={busy} onFund={() => void fund("ETH")} />
        <FundingField label={`${network === "mainnet" ? "Base" : "Base Sepolia"} ${collateralLabel}`} value={usdcAmount} onChange={setUsdcAmount} button="Fund USDC" disabled={busy || !collateral} onFund={() => void fund("USDC")} />
      </div>
      <p className="mt-2 text-[11px] text-faint">Each transfer has its own wallet confirmation. USDC is transferred directly—there is no approval or spending allowance.</p>
      {status.kind !== "idle" && <p className={`mt-3 rounded-lg border p-3 text-[12px] ${status.kind === "error" ? "border-crit/30 bg-crit/10 text-crit" : status.kind === "success" ? "border-calm/30 bg-calm/10 text-calm" : "border-edge bg-panel2 text-muted"}`}>{status.message} {status.hash && <ExplorerLink network={network} resource="tx" value={status.hash} className="underline">View transaction</ExplorerLink>}</p>}
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

function useReadAccountAddress(owner: Address | undefined, factory: Address | undefined, chainId: 8453 | 84532) {
  return useReadContract({
    address: factory,
    abi: mandateAccountFactoryAbi,
    functionName: "getAddress",
    args: owner ? [owner, zeroHash] : undefined,
    chainId,
    query: { enabled: Boolean(owner && factory) },
  });
}
