// Only the untyped dependency APIs used by the harness are declared here.
declare module 'solc' {
  const solc: {
    compile(input: string, callbacks: {
      import(path: string): { contents: string } | { error: string };
    }): string;
  };
  export default solc;
}

declare module 'circomlibjs' {
  export const poseidonContract: {
    generateABI(inputs: number): import('ethers').InterfaceAbi;
    createCode(inputs: number): string;
  };
}
