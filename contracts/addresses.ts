export const addresses = {
    EverValueCoin: "0xf7c9574838f2ecD679f670E978F71949b1717F83",
    WBTCMock: "0xdfF1cA8e0611e6D46efF73eA2d1002fFa2933C87",
    SLSburnVaultFactory: "0x8E205D6e392A5BA3b69F35AD41546bAEde43f5d1",
    SLSPayer: "0x7A4D7df3197e7D38D5597De0dA615ccc054b157E",
} as const;

export type KnownAddress = keyof typeof addresses;

