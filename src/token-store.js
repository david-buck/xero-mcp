import { chmod, mkdir, readFile, rename, open, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const tokenPath = join(homedir(), ".xero-mcp", "tokens.json");

export function createTokenStore(tokenPath, { rename: renameFile = rename, remove: removeFile = rm } = {}) {
  function getTokenPath() {
    return tokenPath;
  }

  async function loadTokens() {
    try {
      return JSON.parse(await readFile(tokenPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        throw new Error(`Could not parse ${tokenPath}. Run \`npm run auth\` again.`);
      }
      throw error;
    }
  }

  async function saveTokens(tokens) {
    const directory = dirname(tokenPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);

    const temporaryPath = `${tokenPath}.${process.pid}.${randomUUID()}.tmp`;
    let temporaryFile;
    try {
      temporaryFile = await open(temporaryPath, "wx", 0o600);
      await temporaryFile.writeFile(`${JSON.stringify(tokens, null, 2)}\n`);
      await temporaryFile.close();
      await chmod(temporaryPath, 0o600);
      await renameFile(temporaryPath, tokenPath);
      await chmod(tokenPath, 0o600);
    } catch (error) {
      if (temporaryFile) {
        await temporaryFile.close().catch(() => {});
        await removeFile(temporaryPath, { force: true }).catch(() => {});
      }
      throw error;
    }
  }

  return { getTokenPath, loadTokens, saveTokens };
}

export const { getTokenPath, loadTokens, saveTokens } = createTokenStore(tokenPath);
