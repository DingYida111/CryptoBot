import fs from "fs";
import path from "path";

interface SecretSpec {
  envName: string;
  fileEnvName?: string;
  defaultFileName?: string;
  secretDirEnvName?: string;
}

export interface OkxCredentialSet {
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
}

const DEFAULT_OKX_SECRET_DIR = path.resolve(process.cwd(), "secrets");

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readSecretFile(filePath: string): string | undefined {
  try {
    return clean(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveSecretFilePath(spec: SecretSpec): string | undefined {
  const explicitPath = clean(spec.fileEnvName ? process.env[spec.fileEnvName] : undefined);
  if (explicitPath) {
    return path.isAbsolute(explicitPath)
      ? explicitPath
      : path.resolve(process.cwd(), explicitPath);
  }

  if (!spec.defaultFileName) return undefined;
  const secretDir = clean(process.env[spec.secretDirEnvName ?? "OKX_SECRET_DIR"]) ?? DEFAULT_OKX_SECRET_DIR;
  return path.resolve(secretDir, spec.defaultFileName);
}

export function getSecretValue(spec: SecretSpec): string | undefined {
  const envValue = clean(process.env[spec.envName]);
  if (envValue) return envValue;

  const filePath = resolveSecretFilePath(spec);
  if (!filePath) return undefined;
  return readSecretFile(filePath);
}

export function getOkxCredentialSet(preferLive: boolean): OkxCredentialSet {
  const paper = {
    apiKey: getSecretValue({
      envName: "OKX_API_KEY",
      fileEnvName: "OKX_API_KEY_FILE",
      defaultFileName: "okx_api_key",
    }),
    apiSecret: getSecretValue({
      envName: "OKX_API_SECRET",
      fileEnvName: "OKX_API_SECRET_FILE",
      defaultFileName: "okx_api_secret",
    }),
    apiPassphrase: getSecretValue({
      envName: "OKX_API_PASSPHRASE",
      fileEnvName: "OKX_API_PASSPHRASE_FILE",
      defaultFileName: "okx_api_passphrase",
    }),
  };

  if (!preferLive) {
    return paper;
  }

  return {
    apiKey: getSecretValue({
      envName: "OKX_LIVE_API_KEY",
      fileEnvName: "OKX_LIVE_API_KEY_FILE",
      defaultFileName: "okx_live_api_key",
    }) ?? paper.apiKey,
    apiSecret: getSecretValue({
      envName: "OKX_LIVE_API_SECRET",
      fileEnvName: "OKX_LIVE_API_SECRET_FILE",
      defaultFileName: "okx_live_api_secret",
    }) ?? paper.apiSecret,
    apiPassphrase: getSecretValue({
      envName: "OKX_LIVE_PASSPHRASE",
      fileEnvName: "OKX_LIVE_PASSPHRASE_FILE",
      defaultFileName: "okx_live_api_passphrase",
    }) ?? paper.apiPassphrase,
  };
}
