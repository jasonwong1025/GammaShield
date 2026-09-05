"use client";

import { useEffect, useState } from "react";
import { useAccount, useBalance, useBytecode, useReadContract, useSendTransaction, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";
import { formatEther, formatUnits, parseEther, parseUnits, zeroAddress, zeroHash, type Address, type Hex } from "viem";
import { erc20Abi, mandateAccountAbi, mandateAccountFactoryAbi, useReadErc20BalanceOf } from "@/lib/generated/contracts";
import { shortAddr } from "@/lib/format";
import { wagmiConfig } from "@/lib/wagmi";
import { MandateSigningPanel } from "./MandateSigningPanel";
import { AgentStatusHeader } from "./AgentStatusHeader";
import { AgentMonitoringPanel } from "./AgentMonitoringPanel";
import { StepHeader } from "./StepHeader";
import { ExplorerLink } from "./ExplorerLink";
import { useExecutionNetwork } from "./ExecutionNetworkProvider";
import { policyNetwork } from "@/lib/policyNetwork";
import { ensureWalletChain, walletActionError } from "@/lib/walletChain";
import type { OptionsAsset } from "@/lib/assets";

export function PolicyAccountPanel({ asset, spot }: { asset: OptionsAsset; spot: number }) {
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
  const [policyDetailsOpen, setPolicyDetailsOpen] = useState(false);

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

  const live = deployed && accountAddress && activeMandate;
  return (
    <>
      {/* What it is doing now, kept apart from what it is allowed to do. Once
          a policy is live this is the only part worth reading on most visits,
          so it sits above the setup it came from rather than below it. */}
      {live && (
        <section className="agent-surface" aria-label="Agent status">
          <AgentStatusHeader account={accountAddress} mandateHash={activeMandate} network={network} chainId={policy.chainId} />
          <div className="p-5">
            <AgentMonitoringPanel account={accountAddress} mandateHash={activeMandate} network={network} />
          </div>
        </section>
      )}

      {live && (
        <button
          type="button"
          className="agent-disclosure"
          aria-expanded={policyDetailsOpen}
          aria-controls="policy-controls"
          onClick={() => setPolicyDetailsOpen((open) => !open)}
        >
          <span>Policy controls</span>
          <span aria-hidden>{policyDetailsOpen ? "⌃" : "⌄"}</span>
        </button>
      )}

      {(!live || policyDetailsOpen) && <section id={live ? "policy-controls" : undefined} className="agent-surface" aria-label="Policy account setup">
        {!policy.factory || !policy.agent ? (
          <p className="m-5 rounded-lg border border-crit/30 bg-crit/10 p-3 text-[12px] text-crit">The {network === "mainnet" ? "Base-mainnet" : "Base Sepolia"} policy-account factory or agent is not configured.</p>
        ) : !isConnected || !address ? (
          <div className="p-5">
            <h3 className="text-[15px] font-bold tracking-[-0.01em] text-fg">Set up the agent</h3>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">Connect the wallet that will own this policy account. Create it once, choose its limits, then add funds.</p>
          </div>
        ) : (
          <div className="rowlist px-5">
            {deployed && accountAddress ? (
              <div className="flex items-center justify-between gap-4 py-3.5">
                <span className="text-[13px] font-semibold text-fg">Policy account</span>
                <span className="flex shrink-0 items-center gap-3 text-[12px]">
                  <ExplorerLink network={network} resource="address" value={accountAddress} className="font-mono text-fg hover:text-blue">{shortAddr(accountAddress)}</ExplorerLink>
                </span>
              </div>
            ) : (
              <div className="py-5 first:pt-0">
                <StepHeader title="Policy account">
                  A dedicated smart account on {network === "mainnet" ? "Base mainnet" : "Base Sepolia"} holds the funds the agent may
                  spend. It cannot act until you register a bounded mandate.
                </StepHeader>

                <div className="readout mt-3 grid gap-2 p-3 text-[12px] sm:grid-cols-[130px_1fr]">
                  <span className="text-faint">Owner wallet</span>
                  <ExplorerLink network={network} resource="address" value={address} className="font-mono text-fg hover:text-blue">{shortAddr(address)}</ExplorerLink>
                  <span className="text-faint">Derived account</span>
                  {accountAddress ? <ExplorerLink network={network} resource="address" value={accountAddress} className="font-mono text-fg hover:text-blue">{shortAddr(accountAddress)}</ExplorerLink> : <span className="font-mono text-fg">{isDeriving ? "Deriving…" : "Unavailable"}</span>}
                </div>

                {deriveError && <p className="mt-2 text-[12px] text-crit">Could not derive the policy account on {network === "mainnet" ? "Base mainnet" : "Base Sepolia"}.</p>}
                {accountAddress && isCheckingDeployment && <p className="mt-2 text-[12px] text-muted">Checking whether the deterministic policy account is already deployed…</p>}
                {accountStateUnknown && <p className="mt-2 text-[12px] text-crit">Could not verify whether this policy account is deployed. Reload or restore the Base RPC connection before submitting another deployment.</p>}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => void createAccount()} disabled={busy || isDeriving || isCheckingDeployment || !canDerive || accountStateUnknown} className="h-9 rounded-lg bg-blue px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:cursor-wait disabled:opacity-60">
                    {isSwitching ? "Switching network…" : isSubmitting ? "Confirm in wallet…" : isConfirming ? "Deploying account…" : "Create policy account"}
                  </button>
                  {!deployed && <span className="text-[12px] text-faint">One wallet transaction. It does not enable trading on its own.</span>}
                </div>

                {isConfirming && transactionHash && <p className="mt-3 text-[12px] text-muted">Deployment submitted; awaiting Base confirmation. <ExplorerLink network={network} resource="tx" value={transactionHash} className="text-blue underline">View transaction</ExplorerLink></p>}
                {(isSuccess || deploymentMessage) && <p className="mt-3 text-[12px] text-muted">{isSuccess ? <>Policy account deployed. It still needs signed limits and funding before it can act. {transactionHash && <ExplorerLink network={network} resource="tx" value={transactionHash} className="text-blue hover:underline">View deployment</ExplorerLink>}</> : deploymentMessage}</p>}
              </div>
            )}

            {deployed && accountAddress ? (
              <>
                <MandateSigningPanel key={accountAddress} owner={address} account={accountAddress} network={network} asset={asset} spot={spot} />
                <PolicyFundingPanel account={accountAddress} network={network} collateral={policy.collateral} collateralLabel={policy.collateralLabel} chainId={policy.chainId} />
              </>
            ) : null}
          </div>
        )}
      </section>}
    </>
  );
}

function PolicyFundingPanel({ account, network, collateral, collateralLabel, chainId: targetChainId }: { account: Address; network: "mainnet" | "sepolia"; collateral: Address | undefined; collateralLabel: string; chainId: 8453 | 84532 }) {
  const { address: owner, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { sendTransactionAsync } = useSendTransaction();
  const { writeContractAsync } = useWriteContract();
  const [ethAmount, setEthAmount] = useState("0.001");
  const [usdcAmount, setUsdcAmount] = useState("5");
  const [open, setOpen] = useState(false);
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
  // Funded means both: ETH pays for the UserOperation, collateral pays for the
  // fill, and the agent is stuck without either.
  const funded = Boolean(ethBalance?.value && usdcBalance);
  const balanceText = `${ethBalance ? displayAmount(formatEther(ethBalance.value)) : "…"} ETH, ${usdcBalance != null ? displayAmount(formatUnits(usdcBalance, 6)) : "…"} ${collateralLabel}`;

  // The form is not the resting state. Funded, this is one line reporting a
  // balance; unfunded, it is one line saying what is missing — either way you
  // open the form deliberately rather than scrolling past it every visit.
  if (!open) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3.5">
        <span className={`text-[13px] font-semibold ${funded ? "text-fg" : "text-warn"}`}>
          {funded ? "Funding available" : ethBalance?.value ? `Needs ${collateralLabel} before it can trade` : "Needs funding before it can trade"}
        </span>
        <span className="flex shrink-0 items-center gap-3 text-[12px]">
          <span className="num text-muted">{balanceText}</span>
          <button type="button" onClick={() => setOpen(true)} className="font-semibold text-blue hover:underline">{funded ? "Add funds" : "Fund it"}</button>
        </span>
      </div>
    );
  }

  return (
    <section className="py-5" aria-label="Fund policy account">
      <StepHeader title="Fund the account">
        Transfers go straight from your wallet to this policy account. ETH pays transaction gas; {collateralLabel} is the collateral
        the agent trades with.
      </StepHeader>

      <div className="rowlist mt-3">
        <div className="flex items-baseline justify-between gap-4 py-2">
          <span className="text-[12px] text-muted">Recipient</span>
          <ExplorerLink network={network} resource="address" value={account} className="font-mono text-[12px] text-fg hover:text-blue">{shortAddr(account)}</ExplorerLink>
        </div>
        <div className="flex items-baseline justify-between gap-4 py-2">
          <span className="text-[12px] text-muted">Balance</span>
          <span className="num text-[13px] font-semibold text-fg">{balanceText}</span>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <FundingField label={`${network === "mainnet" ? "Base" : "Base Sepolia"} ETH`} value={ethAmount} onChange={setEthAmount} button="Fund ETH" disabled={busy} onFund={() => void fund("ETH")} />
        <FundingField label={`${network === "mainnet" ? "Base" : "Base Sepolia"} ${collateralLabel}`} value={usdcAmount} onChange={setUsdcAmount} button={`Fund ${collateralLabel}`} disabled={busy || !collateral} onFund={() => void fund("USDC")} />
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-faint">Each transfer is confirmed in your wallet. Nothing is approved or delegated.</p>
        <button type="button" onClick={() => setOpen(false)} className="text-[12px] font-semibold text-muted hover:text-fg">Done</button>
      </div>
      {status.kind !== "idle" && <p className={`mt-3 text-[12px] ${status.kind === "error" ? "text-crit" : status.kind === "success" ? "text-calm" : "text-muted"}`}>{status.message} {status.hash && <ExplorerLink network={network} resource="tx" value={status.hash} className="underline">View transaction</ExplorerLink>}</p>}
    </section>
  );
}

function FundingField({ label, value, onChange, button, disabled, onFund }: { label: string; value: string; onChange: (value: string) => void; button: string; disabled: boolean; onFund: () => void }) {
  return (
    <div>
      <label className="field flex items-baseline gap-2 p-2.5">
        <span className="text-[12px] text-muted">{label}</span>
        <input type="text" inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} className="num min-w-0 flex-1 bg-transparent text-right text-[13px] font-semibold text-fg outline-none" aria-label={`${label} funding amount`} />
      </label>
      <button type="button" onClick={onFund} disabled={disabled} className="mt-2 h-8 w-full rounded-lg bg-panel3 px-3 text-[12px] font-semibold text-blue hover:bg-panel2 disabled:cursor-wait disabled:opacity-60">{button}</button>
    </div>
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
