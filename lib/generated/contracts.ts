import {
  createUseReadContract,
  createUseWriteContract,
  createUseSimulateContract,
  createUseWatchContractEvent,
} from 'wagmi/codegen'

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// ShadowOptionBook
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const shadowOptionBookAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: 'collateral_', internalType: 'address', type: 'address' },
      { name: 'attester_', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'attester',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'collateral',
    outputs: [{ name: '', internalType: 'contract IERC20', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'domainSeparator',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: 'quote',
        internalType: 'struct ShadowOptionBook.ShadowQuote',
        type: 'tuple',
        components: [
          { name: 'fillId', internalType: 'bytes32', type: 'bytes32' },
          { name: 'sourceHash', internalType: 'bytes32', type: 'bytes32' },
          { name: 'asset', internalType: 'bytes32', type: 'bytes32' },
          { name: 'buyer', internalType: 'address', type: 'address' },
          { name: 'isCall', internalType: 'bool', type: 'bool' },
          { name: 'strikeE8', internalType: 'uint128', type: 'uint128' },
          { name: 'expiry', internalType: 'uint64', type: 'uint64' },
          { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
          { name: 'contractsE6', internalType: 'uint128', type: 'uint128' },
          { name: 'premiumUsdc', internalType: 'uint128', type: 'uint128' },
        ],
      },
      { name: 'signature', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'fillShadow',
    outputs: [{ name: 'positionId', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'nextPositionId',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    name: 'positions',
    outputs: [
      { name: 'sourceHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'asset', internalType: 'bytes32', type: 'bytes32' },
      { name: 'buyer', internalType: 'address', type: 'address' },
      { name: 'isCall', internalType: 'bool', type: 'bool' },
      { name: 'strikeE8', internalType: 'uint128', type: 'uint128' },
      { name: 'expiry', internalType: 'uint64', type: 'uint64' },
      { name: 'contractsE6', internalType: 'uint128', type: 'uint128' },
      { name: 'premiumUsdc', internalType: 'uint128', type: 'uint128' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    name: 'usedFillIds',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'positionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: true,
      },
      {
        name: 'fillId',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'sourceHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'buyer',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'asset',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: false,
      },
      { name: 'isCall', internalType: 'bool', type: 'bool', indexed: false },
      {
        name: 'strikeE8',
        internalType: 'uint128',
        type: 'uint128',
        indexed: false,
      },
      {
        name: 'expiry',
        internalType: 'uint64',
        type: 'uint64',
        indexed: false,
      },
      {
        name: 'contractsE6',
        internalType: 'uint128',
        type: 'uint128',
        indexed: false,
      },
      {
        name: 'premiumUsdc',
        internalType: 'uint128',
        type: 'uint128',
        indexed: false,
      },
    ],
    name: 'ShadowOrderFilled',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// erc20
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const erc20Abi = [
  {
    type: 'event',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'spender', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
    name: 'Approval',
  },
  {
    type: 'event',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
    name: 'Transfer',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    name: 'allowance',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'approve',
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'decimals',
    outputs: [{ type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'name',
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'symbol',
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'totalSupply',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// React
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link shadowOptionBookAbi}__
 */
export const useReadShadowOptionBook = /*#__PURE__*/ createUseReadContract({
  abi: shadowOptionBookAbi,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"attester"`
 */
export const useReadShadowOptionBookAttester =
  /*#__PURE__*/ createUseReadContract({
    abi: shadowOptionBookAbi,
    functionName: 'attester',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"collateral"`
 */
export const useReadShadowOptionBookCollateral =
  /*#__PURE__*/ createUseReadContract({
    abi: shadowOptionBookAbi,
    functionName: 'collateral',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"domainSeparator"`
 */
export const useReadShadowOptionBookDomainSeparator =
  /*#__PURE__*/ createUseReadContract({
    abi: shadowOptionBookAbi,
    functionName: 'domainSeparator',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"nextPositionId"`
 */
export const useReadShadowOptionBookNextPositionId =
  /*#__PURE__*/ createUseReadContract({
    abi: shadowOptionBookAbi,
    functionName: 'nextPositionId',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"positions"`
 */
export const useReadShadowOptionBookPositions =
  /*#__PURE__*/ createUseReadContract({
    abi: shadowOptionBookAbi,
    functionName: 'positions',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"usedFillIds"`
 */
export const useReadShadowOptionBookUsedFillIds =
  /*#__PURE__*/ createUseReadContract({
    abi: shadowOptionBookAbi,
    functionName: 'usedFillIds',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link shadowOptionBookAbi}__
 */
export const useWriteShadowOptionBook = /*#__PURE__*/ createUseWriteContract({
  abi: shadowOptionBookAbi,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"fillShadow"`
 */
export const useWriteShadowOptionBookFillShadow =
  /*#__PURE__*/ createUseWriteContract({
    abi: shadowOptionBookAbi,
    functionName: 'fillShadow',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link shadowOptionBookAbi}__
 */
export const useSimulateShadowOptionBook =
  /*#__PURE__*/ createUseSimulateContract({ abi: shadowOptionBookAbi })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"fillShadow"`
 */
export const useSimulateShadowOptionBookFillShadow =
  /*#__PURE__*/ createUseSimulateContract({
    abi: shadowOptionBookAbi,
    functionName: 'fillShadow',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link shadowOptionBookAbi}__
 */
export const useWatchShadowOptionBookEvent =
  /*#__PURE__*/ createUseWatchContractEvent({ abi: shadowOptionBookAbi })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `eventName` set to `"ShadowOrderFilled"`
 */
export const useWatchShadowOptionBookShadowOrderFilledEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: shadowOptionBookAbi,
    eventName: 'ShadowOrderFilled',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link erc20Abi}__
 */
export const useReadErc20 = /*#__PURE__*/ createUseReadContract({
  abi: erc20Abi,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"allowance"`
 */
export const useReadErc20Allowance = /*#__PURE__*/ createUseReadContract({
  abi: erc20Abi,
  functionName: 'allowance',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"balanceOf"`
 */
export const useReadErc20BalanceOf = /*#__PURE__*/ createUseReadContract({
  abi: erc20Abi,
  functionName: 'balanceOf',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"decimals"`
 */
export const useReadErc20Decimals = /*#__PURE__*/ createUseReadContract({
  abi: erc20Abi,
  functionName: 'decimals',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"name"`
 */
export const useReadErc20Name = /*#__PURE__*/ createUseReadContract({
  abi: erc20Abi,
  functionName: 'name',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"symbol"`
 */
export const useReadErc20Symbol = /*#__PURE__*/ createUseReadContract({
  abi: erc20Abi,
  functionName: 'symbol',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"totalSupply"`
 */
export const useReadErc20TotalSupply = /*#__PURE__*/ createUseReadContract({
  abi: erc20Abi,
  functionName: 'totalSupply',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link erc20Abi}__
 */
export const useWriteErc20 = /*#__PURE__*/ createUseWriteContract({
  abi: erc20Abi,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"approve"`
 */
export const useWriteErc20Approve = /*#__PURE__*/ createUseWriteContract({
  abi: erc20Abi,
  functionName: 'approve',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"transfer"`
 */
export const useWriteErc20Transfer = /*#__PURE__*/ createUseWriteContract({
  abi: erc20Abi,
  functionName: 'transfer',
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"transferFrom"`
 */
export const useWriteErc20TransferFrom = /*#__PURE__*/ createUseWriteContract({
  abi: erc20Abi,
  functionName: 'transferFrom',
})

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link erc20Abi}__
 */
export const useSimulateErc20 = /*#__PURE__*/ createUseSimulateContract({
  abi: erc20Abi,
})

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"approve"`
 */
export const useSimulateErc20Approve = /*#__PURE__*/ createUseSimulateContract({
  abi: erc20Abi,
  functionName: 'approve',
})

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"transfer"`
 */
export const useSimulateErc20Transfer = /*#__PURE__*/ createUseSimulateContract(
  { abi: erc20Abi, functionName: 'transfer' },
)

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link erc20Abi}__ and `functionName` set to `"transferFrom"`
 */
export const useSimulateErc20TransferFrom =
  /*#__PURE__*/ createUseSimulateContract({
    abi: erc20Abi,
    functionName: 'transferFrom',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link erc20Abi}__
 */
export const useWatchErc20Event = /*#__PURE__*/ createUseWatchContractEvent({
  abi: erc20Abi,
})

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link erc20Abi}__ and `eventName` set to `"Approval"`
 */
export const useWatchErc20ApprovalEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: erc20Abi,
    eventName: 'Approval',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link erc20Abi}__ and `eventName` set to `"Transfer"`
 */
export const useWatchErc20TransferEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: erc20Abi,
    eventName: 'Transfer',
  })
