import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const tokenPath = join(homedir(), ".xero-mcp", "tokens.json");

export function getTokenPath() {
  return tokenPath;
}

export async function loadTokens() {
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

export async function saveTokens(tokens) {
  const directory = dirname(tokenPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const temporaryPath = `${tokenPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(tokens, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, tokenPath);
  await chmod(tokenPath, 0o600);
}
