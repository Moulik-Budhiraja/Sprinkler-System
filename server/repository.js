import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const EMPTY_DATA = Object.freeze({ schedules: {}, history: [], operations: {} });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalize(data) {
  return {
    schedules: data && typeof data.schedules === "object" && !Array.isArray(data.schedules) ? data.schedules : {},
    history: Array.isArray(data?.history) ? data.history : [],
    operations: data && typeof data.operations === "object" && !Array.isArray(data.operations) ? data.operations : {},
  };
}

export class JsonRepository {
  constructor(dataPath, { recoverMissing = false, lockTimeoutMs = 5000, staleLockMs = 30000 } = {}) {
    this.dataPath = dataPath;
    this.backupPath = `${dataPath}.bak`;
    this.lockPath = `${dataPath}.lock`;
    this.recoverMissing = recoverMissing;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
  }

  async init() {
    await fs.mkdir(path.dirname(this.dataPath), { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(path.dirname(this.dataPath), 0o700);
    } catch {}
    await this.#withLock(async () => {
      try {
        await this.#readCurrent({ repair: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await this.#atomicWrite(structuredClone(EMPTY_DATA));
      }
    });
    return this;
  }

  async read() {
    try {
      return await this.#readCurrent();
    } catch (error) {
      if (error.code !== "ENOENT" || !this.recoverMissing) throw error;
      return this.#withLock(async () => {
        try {
          return await this.#readCurrent();
        } catch (inner) {
          if (inner.code !== "ENOENT") throw inner;
          const empty = structuredClone(EMPTY_DATA);
          await this.#atomicWrite(empty);
          return empty;
        }
      });
    }
  }

  async mutate(mutator) {
    return this.#withLock(async () => {
      let data;
      try {
        data = await this.#readCurrent({ repair: true });
      } catch (error) {
        if (error.code !== "ENOENT" || !this.recoverMissing) throw error;
        data = structuredClone(EMPTY_DATA);
      }
      const result = await mutator(data);
      await this.#atomicWrite(data);
      return result;
    });
  }

  async #readCurrent({ repair = false } = {}) {
    let raw;
    try {
      raw = await fs.readFile(this.dataPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        try {
          raw = await fs.readFile(this.backupPath, "utf8");
          const recovered = normalize(JSON.parse(raw));
          if (repair) await this.#atomicWrite(recovered, { preserveBackup: true });
          return recovered;
        } catch (backupError) {
          if (backupError.code === "ENOENT") throw error;
          throw backupError;
        }
      }
      throw error;
    }
    try {
      return normalize(JSON.parse(raw));
    } catch (parseError) {
      try {
        const backup = normalize(JSON.parse(await fs.readFile(this.backupPath, "utf8")));
        if (repair) await this.#atomicWrite(backup, { preserveBackup: true });
        return backup;
      } catch {
        throw parseError;
      }
    }
  }

  async #acquireLock() {
    const started = Date.now();
    while (true) {
      try {
        await fs.mkdir(this.lockPath, { mode: 0o700 });
        await fs.writeFile(path.join(this.lockPath, "owner"), `${process.pid}\n`, { mode: 0o600 });
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const stat = await fs.stat(this.lockPath);
          if (Date.now() - stat.mtimeMs > this.staleLockMs) {
            await fs.rm(this.lockPath, { recursive: true, force: true });
            continue;
          }
        } catch (statError) {
          if (statError.code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() - started >= this.lockTimeoutMs) throw new Error("datastore lock timeout");
        await sleep(8 + Math.floor(Math.random() * 8));
      }
    }
  }

  async #withLock(work) {
    await this.#acquireLock();
    try {
      return await work();
    } finally {
      await fs.rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async #atomicWrite(data, { preserveBackup = false } = {}) {
    const directory = path.dirname(this.dataPath);
    const tmp = path.join(directory, `.${path.basename(this.dataPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    const payload = `${JSON.stringify(normalize(data))}\n`;
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!preserveBackup) {
      try {
        await fs.copyFile(this.dataPath, this.backupPath);
        await fs.chmod(this.backupPath, 0o600);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await fs.rename(tmp, this.dataPath);
    await fs.chmod(this.dataPath, 0o600);
    try {
      const dirHandle = await fs.open(directory, "r");
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    } catch (error) {
      if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error.code)) throw error;
    }
  }
}
