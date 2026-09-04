import {
  createUseReadContract,
  createUseWriteContract,
  createUseSimulateContract,
  createUseWatchContractEvent,
} from 'wagmi/codegen'

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MandateAccount
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const mandateAccountAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: 'entryPoint_', internalType: 'address', type: 'address' },
      { name: 'owner_', internalType: 'address', type: 'address' },
      { name: 'riskAttester_', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  { type: 'receive', stateMutability: 'payable' },
  {
    type: 'function',
    inputs: [],
    name: 'activeMandateHash',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    name: 'controls',
    outputs: [
      { name: 'paused', internalType: 'bool', type: 'bool' },
      { name: 'revoked', internalType: 'bool', type: 'bool' },
      { name: 'spentPremium', internalType: 'uint256', type: 'uint256' },
      { name: 'lastExecutionAt', internalType: 'uint64', type: 'uint64' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'entryPoint',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'to', internalType: 'address', type: 'address' },
      { name: 'value', internalType: 'uint256', type: 'uint256' },
      { name: 'data', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'executeOwner',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'hash', internalType: 'bytes32', type: 'bytes32' },
      {
        name: 'risk',
        internalType: 'struct MandateAccount.RiskAttestation',
        type: 'tuple',
        components: [
          { name: 'mandateHash', internalType: 'bytes32', type: 'bytes32' },
          { name: 'riskScoreBps', internalType: 'uint16', type: 'uint16' },
          {
            name: 'positionRiskScoreBps',
            internalType: 'uint16',
            type: 'uint16',
          },
          { name: 'observedAt', internalType: 'uint64', type: 'uint64' },
          { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
          {
            name: 'persistenceSeconds',
            internalType: 'uint64',
            type: 'uint64',
          },
        ],
      },
      { name: 'riskSignature', internalType: 'bytes', type: 'bytes' },
      {
        name: 'quote',
        internalType: 'struct IShadowFill.ShadowQuote',
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
      { name: 'quoteSignature', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'executeShadow',
    outputs: [{ name: 'positionId', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'hash', internalType: 'bytes32', type: 'bytes32' },
      {
        name: 'attestation',
        internalType: 'struct MandateAccount.ShadowCloseAttestation',
        type: 'tuple',
        components: [
          { name: 'mandateHash', internalType: 'bytes32', type: 'bytes32' },
          { name: 'closeId', internalType: 'bytes32', type: 'bytes32' },
          { name: 'positionId', internalType: 'uint256', type: 'uint256' },
          { name: 'contractsE6', internalType: 'uint128', type: 'uint128' },
          { name: 'proceedsUsdc', internalType: 'uint128', type: 'uint128' },
          { name: 'observedAt', internalType: 'uint64', type: 'uint64' },
          { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
        ],
      },
      { name: 'attestationSignature', internalType: 'bytes', type: 'bytes' },
      {
        name: 'close',
        internalType: 'struct IShadowFill.ShadowClose',
        type: 'tuple',
        components: [
          { name: 'closeId', internalType: 'bytes32', type: 'bytes32' },
          { name: 'positionId', internalType: 'uint256', type: 'uint256' },
          { name: 'seller', internalType: 'address', type: 'address' },
          { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
          { name: 'contractsE6', internalType: 'uint128', type: 'uint128' },
          { name: 'proceedsUsdc', internalType: 'uint128', type: 'uint128' },
        ],
      },
      { name: 'closeSignature', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'executeShadowClose',
    outputs: [
      { name: 'proceedsUsdc', internalType: 'uint128', type: 'uint128' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'hash', internalType: 'bytes32', type: 'bytes32' },
      {
        name: 'request',
        internalType: 'struct MandateAccount.RollRequest',
        type: 'tuple',
        components: [
          {
            name: 'risk',
            internalType: 'struct MandateAccount.RiskAttestation',
            type: 'tuple',
            components: [
              { name: 'mandateHash', internalType: 'bytes32', type: 'bytes32' },
              { name: 'riskScoreBps', internalType: 'uint16', type: 'uint16' },
              {
                name: 'positionRiskScoreBps',
                internalType: 'uint16',
                type: 'uint16',
              },
              { name: 'observedAt', internalType: 'uint64', type: 'uint64' },
              { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
              {
                name: 'persistenceSeconds',
                internalType: 'uint64',
                type: 'uint64',
              },
            ],
          },
          { name: 'riskSignature', internalType: 'bytes', type: 'bytes' },
          {
            name: 'attestation',
            internalType: 'struct MandateAccount.ShadowCloseAttestation',
            type: 'tuple',
            components: [
              { name: 'mandateHash', internalType: 'bytes32', type: 'bytes32' },
              { name: 'closeId', internalType: 'bytes32', type: 'bytes32' },
              { name: 'positionId', internalType: 'uint256', type: 'uint256' },
              { name: 'contractsE6', internalType: 'uint128', type: 'uint128' },
              {
                name: 'proceedsUsdc',
                internalType: 'uint128',
                type: 'uint128',
              },
              { name: 'observedAt', internalType: 'uint64', type: 'uint64' },
              { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
            ],
          },
          {
            name: 'attestationSignature',
            internalType: 'bytes',
            type: 'bytes',
          },
          {
            name: 'close',
            internalType: 'struct IShadowFill.ShadowClose',
            type: 'tuple',
            components: [
              { name: 'closeId', internalType: 'bytes32', type: 'bytes32' },
              { name: 'positionId', internalType: 'uint256', type: 'uint256' },
              { name: 'seller', internalType: 'address', type: 'address' },
              { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
              { name: 'contractsE6', internalType: 'uint128', type: 'uint128' },
              {
                name: 'proceedsUsdc',
                internalType: 'uint128',
                type: 'uint128',
              },
            ],
          },
          { name: 'closeSignature', internalType: 'bytes', type: 'bytes' },
          {
            name: 'quote',
            internalType: 'struct IShadowFill.ShadowQuote',
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
          { name: 'quoteSignature', internalType: 'bytes', type: 'bytes' },
        ],
      },
    ],
    name: 'executeShadowRoll',
    outputs: [{ name: 'positionId', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'hash', internalType: 'bytes32', type: 'bytes32' },
      {
        name: 'risk',
        internalType: 'struct MandateAccount.RiskAttestation',
        type: 'tuple',
        components: [
          { name: 'mandateHash', internalType: 'bytes32', type: 'bytes32' },
          { name: 'riskScoreBps', internalType: 'uint16', type: 'uint16' },
          {
            name: 'positionRiskScoreBps',
            internalType: 'uint16',
            type: 'uint16',
          },
          { name: 'observedAt', internalType: 'uint64', type: 'uint64' },
          { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
          {
            name: 'persistenceSeconds',
            internalType: 'uint64',
            type: 'uint64',
          },
        ],
      },
      { name: 'riskSignature', internalType: 'bytes', type: 'bytes' },
      {
        name: 'quote',
        internalType: 'struct MandateAccount.ThetanutsQuote',
        type: 'tuple',
        components: [
          { name: 'mandateHash', internalType: 'bytes32', type: 'bytes32' },
          {
            name: 'fillCalldataHash',
            internalType: 'bytes32',
            type: 'bytes32',
          },
          { name: 'premium', internalType: 'uint256', type: 'uint256' },
          { name: 'contracts', internalType: 'uint256', type: 'uint256' },
          { name: 'observedAt', internalType: 'uint64', type: 'uint64' },
          { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
        ],
      },
      { name: 'quoteSignature', internalType: 'bytes', type: 'bytes' },
      { name: 'fillData', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'executeThetanuts',
    outputs: [
      { name: 'optionAddress', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'hash', internalType: 'bytes32', type: 'bytes32' }],
    name: 'getMandate',
    outputs: [
      {
        name: '',
        internalType: 'struct MandateAccount.Mandate',
        type: 'tuple',
        components: [
          { name: 'owner', internalType: 'address', type: 'address' },
          { name: 'account', internalType: 'address', type: 'address' },
          { name: 'agent', internalType: 'address', type: 'address' },
          { name: 'optionBook', internalType: 'address', type: 'address' },
          { name: 'collateral', internalType: 'address', type: 'address' },
          { name: 'asset', internalType: 'bytes32', type: 'bytes32' },
          { name: 'side', internalType: 'uint8', type: 'uint8' },
          {
            name: 'maxPremiumPerFill',
            internalType: 'uint256',
            type: 'uint256',
          },
          { name: 'maxPremiumTotal', internalType: 'uint256', type: 'uint256' },
          {
            name: 'maxContractsPerFill',
            internalType: 'uint256',
            type: 'uint256',
          },
          { name: 'minTenorSeconds', internalType: 'uint64', type: 'uint64' },
          { name: 'maxTenorSeconds', internalType: 'uint64', type: 'uint64' },
          { name: 'riskThresholdBps', internalType: 'uint16', type: 'uint16' },
          {
            name: 'positionRiskThresholdBps',
            internalType: 'uint16',
            type: 'uint16',
          },
          {
            name: 'persistenceSeconds',
            internalType: 'uint64',
            type: 'uint64',
          },
          {
            name: 'minExecutionIntervalSeconds',
            internalType: 'uint64',
            type: 'uint64',
          },
          { name: 'validAfter', internalType: 'uint64', type: 'uint64' },
          { name: 'expiresAt', internalType: 'uint64', type: 'uint64' },
          { name: 'nonce', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'hash', internalType: 'bytes32', type: 'bytes32' }],
    name: 'getRiskHistory',
    outputs: [
      {
        name: 'samples',
        internalType: 'struct MandateAccount.RiskSample[]',
        type: 'tuple[]',
        components: [
          { name: 'observedAt', internalType: 'uint64', type: 'uint64' },
          { name: 'bookScoreBps', internalType: 'uint16', type: 'uint16' },
          { name: 'positionScoreBps', internalType: 'uint16', type: 'uint16' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    name: 'isMandateRegistered',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'mandateDomainSeparator',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: 'mandate',
        internalType: 'struct MandateAccount.Mandate',
        type: 'tuple',
        components: [
          { name: 'owner', internalType: 'address', type: 'address' },
          { name: 'account', internalType: 'address', type: 'address' },
          { name: 'agent', internalType: 'address', type: 'address' },
          { name: 'optionBook', internalType: 'address', type: 'address' },
          { name: 'collateral', internalType: 'address', type: 'address' },
          { name: 'asset', internalType: 'bytes32', type: 'bytes32' },
          { name: 'side', internalType: 'uint8', type: 'uint8' },
          {
            name: 'maxPremiumPerFill',
            internalType: 'uint256',
            type: 'uint256',
          },
          { name: 'maxPremiumTotal', internalType: 'uint256', type: 'uint256' },
          {
            name: 'maxContractsPerFill',
            internalType: 'uint256',
            type: 'uint256',
          },
          { name: 'minTenorSeconds', internalType: 'uint64', type: 'uint64' },
          { name: 'maxTenorSeconds', internalType: 'uint64', type: 'uint64' },
          { name: 'riskThresholdBps', internalType: 'uint16', type: 'uint16' },
          {
            name: 'positionRiskThresholdBps',
            internalType: 'uint16',
            type: 'uint16',
          },
          {
            name: 'persistenceSeconds',
            internalType: 'uint64',
            type: 'uint64',
          },
          {
            name: 'minExecutionIntervalSeconds',
            internalType: 'uint64',
            type: 'uint64',
          },
          { name: 'validAfter', internalType: 'uint64', type: 'uint64' },
          { name: 'expiresAt', internalType: 'uint64', type: 'uint64' },
          { name: 'nonce', internalType: 'uint256', type: 'uint256' },
        ],
      },
    ],
    name: 'mandateHash',
    outputs: [{ name: 'hash', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    inputs: [],
    name: 'owner',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: 'hash', internalType: 'bytes32', type: 'bytes32' }],
    name: 'pauseMandate',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'hash', internalType: 'bytes32', type: 'bytes32' },
      {
        name: 'risk',
        internalType: 'struct MandateAccount.RiskAttestation',
        type: 'tuple',
        components: [
          { name: 'mandateHash', internalType: 'bytes32', type: 'bytes32' },
          { name: 'riskScoreBps', internalType: 'uint16', type: 'uint16' },
          {
            name: 'positionRiskScoreBps',
            internalType: 'uint16',
            type: 'uint16',
          },
          { name: 'observedAt', internalType: 'uint64', type: 'uint64' },
          { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
          {
            name: 'persistenceSeconds',
            internalType: 'uint64',
            type: 'uint64',
          },
        ],
      },
      { name: 'signature', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'recordRisk',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      {
        name: 'mandate',
        internalType: 'struct MandateAccount.Mandate',
        type: 'tuple',
        components: [
          { name: 'owner', internalType: 'address', type: 'address' },
          { name: 'account', internalType: 'address', type: 'address' },
          { name: 'agent', internalType: 'address', type: 'address' },
          { name: 'optionBook', internalType: 'address', type: 'address' },
          { name: 'collateral', internalType: 'address', type: 'address' },
          { name: 'asset', internalType: 'bytes32', type: 'bytes32' },
          { name: 'side', internalType: 'uint8', type: 'uint8' },
          {
            name: 'maxPremiumPerFill',
            internalType: 'uint256',
            type: 'uint256',
          },
          { name: 'maxPremiumTotal', internalType: 'uint256', type: 'uint256' },
          {
            name: 'maxContractsPerFill',
            internalType: 'uint256',
            type: 'uint256',
          },
          { name: 'minTenorSeconds', internalType: 'uint64', type: 'uint64' },
          { name: 'maxTenorSeconds', internalType: 'uint64', type: 'uint64' },
          { name: 'riskThresholdBps', internalType: 'uint16', type: 'uint16' },
          {
            name: 'positionRiskThresholdBps',
            internalType: 'uint16',
            type: 'uint16',
          },
          {
            name: 'persistenceSeconds',
            internalType: 'uint64',
            type: 'uint64',
          },
          {
            name: 'minExecutionIntervalSeconds',
            internalType: 'uint64',
            type: 'uint64',
          },
          { name: 'validAfter', internalType: 'uint64', type: 'uint64' },
          { name: 'expiresAt', internalType: 'uint64', type: 'uint64' },
          { name: 'nonce', internalType: 'uint256', type: 'uint256' },
        ],
      },
      { name: 'signature', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'registerMandate',
    outputs: [{ name: 'hash', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'hash', internalType: 'bytes32', type: 'bytes32' }],
    name: 'resumeMandate',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: 'hash', internalType: 'bytes32', type: 'bytes32' }],
    name: 'revokeMandate',
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'riskAttester',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'riskDomainSeparator',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    name: 'riskObservationCount',
    outputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    name: 'riskStates',
    outputs: [
      { name: 'scoreBps', internalType: 'uint16', type: 'uint16' },
      { name: 'positionScoreBps', internalType: 'uint16', type: 'uint16' },
      { name: 'eligibleSince', internalType: 'uint64', type: 'uint64' },
      { name: 'observedAt', internalType: 'uint64', type: 'uint64' },
      { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'shadowCloseDomainSeparator',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'thetanutsQuoteDomainSeparator',
    outputs: [{ name: '', internalType: 'bytes32', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      {
        name: 'userOp',
        internalType: 'struct PackedUserOperation',
        type: 'tuple',
        components: [
          { name: 'sender', internalType: 'address', type: 'address' },
          { name: 'nonce', internalType: 'uint256', type: 'uint256' },
          { name: 'initCode', internalType: 'bytes', type: 'bytes' },
          { name: 'callData', internalType: 'bytes', type: 'bytes' },
          {
            name: 'accountGasLimits',
            internalType: 'bytes32',
            type: 'bytes32',
          },
          {
            name: 'preVerificationGas',
            internalType: 'uint256',
            type: 'uint256',
          },
          { name: 'gasFees', internalType: 'bytes32', type: 'bytes32' },
          { name: 'paymasterAndData', internalType: 'bytes', type: 'bytes' },
          { name: 'signature', internalType: 'bytes', type: 'bytes' },
        ],
      },
      { name: 'userOpHash', internalType: 'bytes32', type: 'bytes32' },
      { name: 'missingAccountFunds', internalType: 'uint256', type: 'uint256' },
    ],
    name: 'validateUserOp',
    outputs: [
      { name: 'validationData', internalType: 'uint256', type: 'uint256' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'mandateHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'closeId',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'positionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'proceedsUsdc',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'MandateClosed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'mandateHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'fillId',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'premiumUsdc',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'positionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'MandateExecuted',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'mandateHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
    ],
    name: 'MandatePaused',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'mandateHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'expiresAt',
        internalType: 'uint64',
        type: 'uint64',
        indexed: false,
      },
    ],
    name: 'MandateRegistered',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'mandateHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
    ],
    name: 'MandateResumed',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'mandateHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
    ],
    name: 'MandateRevoked',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'mandateHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'closedPositionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
      {
        name: 'openedPositionId',
        internalType: 'uint256',
        type: 'uint256',
        indexed: false,
      },
    ],
    name: 'MandateRolled',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'mandateHash',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'scoreBps',
        internalType: 'uint16',
        type: 'uint16',
        indexed: false,
      },
      {
        name: 'positionScoreBps',
        internalType: 'uint16',
        type: 'uint16',
        indexed: false,
      },
      {
        name: 'eligibleSince',
        internalType: 'uint64',
        type: 'uint64',
        indexed: false,
      },
      {
        name: 'validUntil',
        internalType: 'uint64',
        type: 'uint64',
        indexed: false,
      },
    ],
    name: 'RiskObserved',
  },
  { type: 'error', inputs: [], name: 'EntryPointOnly' },
  { type: 'error', inputs: [], name: 'InvalidClose' },
  { type: 'error', inputs: [], name: 'InvalidMandate' },
  { type: 'error', inputs: [], name: 'InvalidRiskAttestation' },
  { type: 'error', inputs: [], name: 'InvalidRiskObservation' },
  { type: 'error', inputs: [], name: 'InvalidRoll' },
  { type: 'error', inputs: [], name: 'MandateAlreadyRegistered' },
  { type: 'error', inputs: [], name: 'MandateInactive' },
  { type: 'error', inputs: [], name: 'MandateIsRevoked' },
  { type: 'error', inputs: [], name: 'MandateUnavailable' },
  { type: 'error', inputs: [], name: 'OwnerOnly' },
  { type: 'error', inputs: [], name: 'QuoteViolatesMandate' },
  { type: 'error', inputs: [], name: 'RiskNotPersistent' },
  { type: 'error', inputs: [], name: 'RiskObservationStale' },
  { type: 'error', inputs: [], name: 'ThetanutsQuoteViolatesMandate' },
  { type: 'error', inputs: [], name: 'TokenCallFailed' },
  { type: 'error', inputs: [], name: 'TotalCapExceeded' },
  { type: 'error', inputs: [], name: 'ZeroAddress' },
  { type: 'error', inputs: [], name: 'ZeroTarget' },
] as const

//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// MandateAccountFactory
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export const mandateAccountFactoryAbi = [
  {
    type: 'constructor',
    inputs: [
      { name: 'entryPoint_', internalType: 'address', type: 'address' },
      { name: 'riskAttester_', internalType: 'address', type: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'salt', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'createAccount',
    outputs: [
      {
        name: 'account',
        internalType: 'contract MandateAccount',
        type: 'address',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [],
    name: 'entryPoint',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [
      { name: 'owner', internalType: 'address', type: 'address' },
      { name: 'salt', internalType: 'bytes32', type: 'bytes32' },
    ],
    name: 'getAddress',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    inputs: [],
    name: 'riskAttester',
    outputs: [{ name: '', internalType: 'address', type: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    anonymous: false,
    inputs: [
      {
        name: 'account',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      {
        name: 'owner',
        internalType: 'address',
        type: 'address',
        indexed: true,
      },
      { name: 'salt', internalType: 'bytes32', type: 'bytes32', indexed: true },
    ],
    name: 'AccountCreated',
  },
  { type: 'error', inputs: [], name: 'ZeroAddress' },
  { type: 'error', inputs: [], name: 'ZeroOwner' },
] as const

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
    inputs: [
      {
        name: 'close',
        internalType: 'struct ShadowOptionBook.ShadowClose',
        type: 'tuple',
        components: [
          { name: 'closeId', internalType: 'bytes32', type: 'bytes32' },
          { name: 'positionId', internalType: 'uint256', type: 'uint256' },
          { name: 'seller', internalType: 'address', type: 'address' },
          { name: 'validUntil', internalType: 'uint64', type: 'uint64' },
          { name: 'contractsE6', internalType: 'uint128', type: 'uint128' },
          { name: 'proceedsUsdc', internalType: 'uint128', type: 'uint128' },
        ],
      },
      { name: 'signature', internalType: 'bytes', type: 'bytes' },
    ],
    name: 'closeShadow',
    outputs: [
      { name: 'proceedsUsdc', internalType: 'uint128', type: 'uint128' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    inputs: [{ name: '', internalType: 'uint256', type: 'uint256' }],
    name: 'closedAt',
    outputs: [{ name: '', internalType: 'uint64', type: 'uint64' }],
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
    name: 'usedCloseIds',
    outputs: [{ name: '', internalType: 'bool', type: 'bool' }],
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
    type: 'function',
    inputs: [],
    name: 'version',
    outputs: [{ name: '', internalType: 'uint16', type: 'uint16' }],
    stateMutability: 'pure',
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
        name: 'closeId',
        internalType: 'bytes32',
        type: 'bytes32',
        indexed: true,
      },
      {
        name: 'seller',
        internalType: 'address',
        type: 'address',
        indexed: false,
      },
      {
        name: 'contractsE6',
        internalType: 'uint128',
        type: 'uint128',
        indexed: false,
      },
      {
        name: 'proceedsUsdc',
        internalType: 'uint128',
        type: 'uint128',
        indexed: false,
      },
    ],
    name: 'ShadowPositionClosed',
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
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__
 */
export const useReadMandateAccount = /*#__PURE__*/ createUseReadContract({
  abi: mandateAccountAbi,
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"activeMandateHash"`
 */
export const useReadMandateAccountActiveMandateHash =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'activeMandateHash',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"controls"`
 */
export const useReadMandateAccountControls =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'controls',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"entryPoint"`
 */
export const useReadMandateAccountEntryPoint =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'entryPoint',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"getMandate"`
 */
export const useReadMandateAccountGetMandate =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'getMandate',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"getRiskHistory"`
 */
export const useReadMandateAccountGetRiskHistory =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'getRiskHistory',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"isMandateRegistered"`
 */
export const useReadMandateAccountIsMandateRegistered =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'isMandateRegistered',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"mandateDomainSeparator"`
 */
export const useReadMandateAccountMandateDomainSeparator =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'mandateDomainSeparator',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"mandateHash"`
 */
export const useReadMandateAccountMandateHash =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'mandateHash',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"owner"`
 */
export const useReadMandateAccountOwner = /*#__PURE__*/ createUseReadContract({
  abi: mandateAccountAbi,
  functionName: 'owner',
})

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"riskAttester"`
 */
export const useReadMandateAccountRiskAttester =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'riskAttester',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"riskDomainSeparator"`
 */
export const useReadMandateAccountRiskDomainSeparator =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'riskDomainSeparator',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"riskObservationCount"`
 */
export const useReadMandateAccountRiskObservationCount =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'riskObservationCount',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"riskStates"`
 */
export const useReadMandateAccountRiskStates =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'riskStates',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"shadowCloseDomainSeparator"`
 */
export const useReadMandateAccountShadowCloseDomainSeparator =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'shadowCloseDomainSeparator',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"thetanutsQuoteDomainSeparator"`
 */
export const useReadMandateAccountThetanutsQuoteDomainSeparator =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountAbi,
    functionName: 'thetanutsQuoteDomainSeparator',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__
 */
export const useWriteMandateAccount = /*#__PURE__*/ createUseWriteContract({
  abi: mandateAccountAbi,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"executeOwner"`
 */
export const useWriteMandateAccountExecuteOwner =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountAbi,
    functionName: 'executeOwner',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"executeShadow"`
 */
export const useWriteMandateAccountExecuteShadow =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountAbi,
    functionName: 'executeShadow',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"executeShadowClose"`
 */
export const useWriteMandateAccountExecuteShadowClose =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountAbi,
    functionName: 'executeShadowClose',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"executeShadowRoll"`
 */
export const useWriteMandateAccountExecuteShadowRoll =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountAbi,
    functionName: 'executeShadowRoll',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"executeThetanuts"`
 */
export const useWriteMandateAccountExecuteThetanuts =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountAbi,
    functionName: 'executeThetanuts',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"pauseMandate"`
 */
export const useWriteMandateAccountPauseMandate =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountAbi,
    functionName: 'pauseMandate',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"recordRisk"`
 */
export const useWriteMandateAccountRecordRisk =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountAbi,
    functionName: 'recordRisk',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"registerMandate"`
 */
export const useWriteMandateAccountRegisterMandate =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountAbi,
    functionName: 'registerMandate',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"resumeMandate"`
 */
export const useWriteMandateAccountResumeMandate =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountAbi,
    functionName: 'resumeMandate',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"revokeMandate"`
 */
export const useWriteMandateAccountRevokeMandate =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountAbi,
    functionName: 'revokeMandate',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"validateUserOp"`
 */
export const useWriteMandateAccountValidateUserOp =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountAbi,
    functionName: 'validateUserOp',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__
 */
export const useSimulateMandateAccount =
  /*#__PURE__*/ createUseSimulateContract({ abi: mandateAccountAbi })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"executeOwner"`
 */
export const useSimulateMandateAccountExecuteOwner =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountAbi,
    functionName: 'executeOwner',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"executeShadow"`
 */
export const useSimulateMandateAccountExecuteShadow =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountAbi,
    functionName: 'executeShadow',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"executeShadowClose"`
 */
export const useSimulateMandateAccountExecuteShadowClose =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountAbi,
    functionName: 'executeShadowClose',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"executeShadowRoll"`
 */
export const useSimulateMandateAccountExecuteShadowRoll =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountAbi,
    functionName: 'executeShadowRoll',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"executeThetanuts"`
 */
export const useSimulateMandateAccountExecuteThetanuts =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountAbi,
    functionName: 'executeThetanuts',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"pauseMandate"`
 */
export const useSimulateMandateAccountPauseMandate =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountAbi,
    functionName: 'pauseMandate',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"recordRisk"`
 */
export const useSimulateMandateAccountRecordRisk =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountAbi,
    functionName: 'recordRisk',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"registerMandate"`
 */
export const useSimulateMandateAccountRegisterMandate =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountAbi,
    functionName: 'registerMandate',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"resumeMandate"`
 */
export const useSimulateMandateAccountResumeMandate =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountAbi,
    functionName: 'resumeMandate',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"revokeMandate"`
 */
export const useSimulateMandateAccountRevokeMandate =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountAbi,
    functionName: 'revokeMandate',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountAbi}__ and `functionName` set to `"validateUserOp"`
 */
export const useSimulateMandateAccountValidateUserOp =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountAbi,
    functionName: 'validateUserOp',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link mandateAccountAbi}__
 */
export const useWatchMandateAccountEvent =
  /*#__PURE__*/ createUseWatchContractEvent({ abi: mandateAccountAbi })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link mandateAccountAbi}__ and `eventName` set to `"MandateClosed"`
 */
export const useWatchMandateAccountMandateClosedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: mandateAccountAbi,
    eventName: 'MandateClosed',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link mandateAccountAbi}__ and `eventName` set to `"MandateExecuted"`
 */
export const useWatchMandateAccountMandateExecutedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: mandateAccountAbi,
    eventName: 'MandateExecuted',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link mandateAccountAbi}__ and `eventName` set to `"MandatePaused"`
 */
export const useWatchMandateAccountMandatePausedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: mandateAccountAbi,
    eventName: 'MandatePaused',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link mandateAccountAbi}__ and `eventName` set to `"MandateRegistered"`
 */
export const useWatchMandateAccountMandateRegisteredEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: mandateAccountAbi,
    eventName: 'MandateRegistered',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link mandateAccountAbi}__ and `eventName` set to `"MandateResumed"`
 */
export const useWatchMandateAccountMandateResumedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: mandateAccountAbi,
    eventName: 'MandateResumed',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link mandateAccountAbi}__ and `eventName` set to `"MandateRevoked"`
 */
export const useWatchMandateAccountMandateRevokedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: mandateAccountAbi,
    eventName: 'MandateRevoked',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link mandateAccountAbi}__ and `eventName` set to `"MandateRolled"`
 */
export const useWatchMandateAccountMandateRolledEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: mandateAccountAbi,
    eventName: 'MandateRolled',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link mandateAccountAbi}__ and `eventName` set to `"RiskObserved"`
 */
export const useWatchMandateAccountRiskObservedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: mandateAccountAbi,
    eventName: 'RiskObserved',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountFactoryAbi}__
 */
export const useReadMandateAccountFactory = /*#__PURE__*/ createUseReadContract(
  { abi: mandateAccountFactoryAbi },
)

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountFactoryAbi}__ and `functionName` set to `"entryPoint"`
 */
export const useReadMandateAccountFactoryEntryPoint =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountFactoryAbi,
    functionName: 'entryPoint',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountFactoryAbi}__ and `functionName` set to `"getAddress"`
 */
export const useReadMandateAccountFactoryGetAddress =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountFactoryAbi,
    functionName: 'getAddress',
  })

/**
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link mandateAccountFactoryAbi}__ and `functionName` set to `"riskAttester"`
 */
export const useReadMandateAccountFactoryRiskAttester =
  /*#__PURE__*/ createUseReadContract({
    abi: mandateAccountFactoryAbi,
    functionName: 'riskAttester',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountFactoryAbi}__
 */
export const useWriteMandateAccountFactory =
  /*#__PURE__*/ createUseWriteContract({ abi: mandateAccountFactoryAbi })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link mandateAccountFactoryAbi}__ and `functionName` set to `"createAccount"`
 */
export const useWriteMandateAccountFactoryCreateAccount =
  /*#__PURE__*/ createUseWriteContract({
    abi: mandateAccountFactoryAbi,
    functionName: 'createAccount',
  })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountFactoryAbi}__
 */
export const useSimulateMandateAccountFactory =
  /*#__PURE__*/ createUseSimulateContract({ abi: mandateAccountFactoryAbi })

/**
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link mandateAccountFactoryAbi}__ and `functionName` set to `"createAccount"`
 */
export const useSimulateMandateAccountFactoryCreateAccount =
  /*#__PURE__*/ createUseSimulateContract({
    abi: mandateAccountFactoryAbi,
    functionName: 'createAccount',
  })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link mandateAccountFactoryAbi}__
 */
export const useWatchMandateAccountFactoryEvent =
  /*#__PURE__*/ createUseWatchContractEvent({ abi: mandateAccountFactoryAbi })

/**
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link mandateAccountFactoryAbi}__ and `eventName` set to `"AccountCreated"`
 */
export const useWatchMandateAccountFactoryAccountCreatedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: mandateAccountFactoryAbi,
    eventName: 'AccountCreated',
  })

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
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"closedAt"`
 */
export const useReadShadowOptionBookClosedAt =
  /*#__PURE__*/ createUseReadContract({
    abi: shadowOptionBookAbi,
    functionName: 'closedAt',
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
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"usedCloseIds"`
 */
export const useReadShadowOptionBookUsedCloseIds =
  /*#__PURE__*/ createUseReadContract({
    abi: shadowOptionBookAbi,
    functionName: 'usedCloseIds',
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
 * Wraps __{@link useReadContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"version"`
 */
export const useReadShadowOptionBookVersion =
  /*#__PURE__*/ createUseReadContract({
    abi: shadowOptionBookAbi,
    functionName: 'version',
  })

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link shadowOptionBookAbi}__
 */
export const useWriteShadowOptionBook = /*#__PURE__*/ createUseWriteContract({
  abi: shadowOptionBookAbi,
})

/**
 * Wraps __{@link useWriteContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"closeShadow"`
 */
export const useWriteShadowOptionBookCloseShadow =
  /*#__PURE__*/ createUseWriteContract({
    abi: shadowOptionBookAbi,
    functionName: 'closeShadow',
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
 * Wraps __{@link useSimulateContract}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `functionName` set to `"closeShadow"`
 */
export const useSimulateShadowOptionBookCloseShadow =
  /*#__PURE__*/ createUseSimulateContract({
    abi: shadowOptionBookAbi,
    functionName: 'closeShadow',
  })

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
 * Wraps __{@link useWatchContractEvent}__ with `abi` set to __{@link shadowOptionBookAbi}__ and `eventName` set to `"ShadowPositionClosed"`
 */
export const useWatchShadowOptionBookShadowPositionClosedEvent =
  /*#__PURE__*/ createUseWatchContractEvent({
    abi: shadowOptionBookAbi,
    eventName: 'ShadowPositionClosed',
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
