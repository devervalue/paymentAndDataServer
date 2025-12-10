export const addresses = {
    EverValueCoin: "0x60d463955EbC150EaB1055A78c32e9437e06c2f2",
    WBTCMock: "0x47440661F5dA72556E3f609B9DE3273764562b8a",
    EVABurnVault: "0x8A4358dC1Af8dc83AFf622a012b95108aE8DFcE0",
    SLSburnVaultFactory: "0xD723c9F9dB6861CB23EBf8Be67bb793e3fDbB83e",
    SLSPayer: "0x7Fb096d91f716755e941D14FE07Ee1de8f970E60",
    FirstSLSburnVault: "0x54618ebA68dA568A442BAAAE942003cFED30f6Ff",
  } as const;
  
  export type KnownAddress = keyof typeof addresses;