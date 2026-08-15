export class ConfigCorruptionError extends Error {
  constructor(detail: string) {
    super(`CONTINUUM config is corrupted and unrecoverable (${detail}).`);
    this.name = "ConfigCorruptionError";
  }
}
