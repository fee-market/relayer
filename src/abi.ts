// Minimal ABIs needed by the relayer.

export const delegationManagerAbi = [
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  {
    type: "function",
    name: "redeemDelegations",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_permissionContexts", type: "bytes[]" },
      { name: "_modes", type: "bytes32[]" },
      { name: "_executionCallDatas", type: "bytes[]" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getDelegationHash",
    stateMutability: "pure",
    inputs: [
      {
        name: "_input",
        type: "tuple",
        components: [
          { name: "delegate", type: "address" },
          { name: "delegator", type: "address" },
          { name: "authority", type: "bytes32" },
          {
            name: "caveats",
            type: "tuple[]",
            components: [
              { name: "enforcer", type: "address" },
              { name: "terms", type: "bytes" },
              { name: "args", type: "bytes" },
            ],
          },
          { name: "salt", type: "uint256" },
          { name: "signature", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

// Generated from the compiled contract (abi/FeeMarketRegistry.json) — see scripts/gen-abi.sh.
export { feeMarketRegistryAbi } from "./generated/feeMarketRegistryAbi.js";

// The Delegation struct tuple type, reused for abi encoding permissionContexts.
export const delegationStructAbi = {
  name: "delegations",
  type: "tuple[]",
  components: [
    { name: "delegate", type: "address" },
    { name: "delegator", type: "address" },
    { name: "authority", type: "bytes32" },
    {
      name: "caveats",
      type: "tuple[]",
      components: [
        { name: "enforcer", type: "address" },
        { name: "terms", type: "bytes" },
        { name: "args", type: "bytes" },
      ],
    },
    { name: "salt", type: "uint256" },
    { name: "signature", type: "bytes" },
  ],
} as const;
