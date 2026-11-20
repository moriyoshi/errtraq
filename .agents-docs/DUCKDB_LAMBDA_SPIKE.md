# DuckDB on AWS Lambda (Node.js 22) spike

Date: 2026-11-21. Region: ap-northeast-1. Everything measured on real Lambda invocations (REPORT and INIT_REPORT log lines); all spike resources were deleted afterwards.

## Versions

- `@duckdb/node-api` 2.0.0-r.1 (npm "latest"; the `lts-v1.4` tag is 1.4.5-r.1, not tested), `@duckdb/node-bindings` 2.0.0-r.1, platform packages `@duckdb/node-bindings-linux-arm64` and `@duckdb/node-bindings-linux-x64` (glibc variants; `-musl` variants exist and must not be used on Lambda)
- DuckDB `v2.0.0` (`select version()`), extension platform strings `linux_arm64` and `linux_amd64`
- Extension versions (from `duckdb_extensions()`): httpfs 77392a7207, avro 345c3f4e82, iceberg 4c0c0874c4, aws available too (about 20.8 MB gz for arm64)
- Runtime: managed `nodejs22.x` (Node 22.x on Amazon Linux 2023, glibc 2.34 as seen in the public.ecr.aws/lambda/nodejs:22 image), arm64 and x86_64
- The package is ESM only: `require('@duckdb/node-api')` fails with MODULE_NOT_FOUND, use `.mjs` / `import`.

## Packaging recipe that worked

Cross-installing the Linux binaries from macOS needs no Docker:

```sh
mkdir pkg && cd pkg && echo '{"name":"fn","version":"1.0.0","private":true}' > package.json
npm i @duckdb/node-api@2.0.0-r.1 --os=linux --cpu=arm64 --libc=glibc   # or --cpu=x64
# node_modules/@duckdb/node-bindings-linux-arm64 = libduckdb.so + duckdb.node, ~96 MB unpacked
```

Optional bundled extensions (official signed binaries, gunzip them):

```sh
for e in httpfs avro iceberg; do
  mkdir -p build/ext/v2.0.0/linux_arm64   # linux_amd64 for x86_64
  curl -sf https://extensions.duckdb.org/v2.0.0/linux_arm64/$e.duckdb_extension.gz | gunzip > build/ext/v2.0.0/linux_arm64/$e.duckdb_extension
done
cp -r node_modules build/ ; cp index.mjs build/ ; (cd build && zip -qr -9 ../fn.zip .)
aws s3 cp fn.zip s3://<bucket>/code/fn.zip --profile <aws-profile>     # >50 MB needs S3 upload
aws lambda create-function --function-name <name> --runtime nodejs22.x --architectures arm64 \
  --handler index.handler --role <role-arn> --code S3Bucket=<bucket>,S3Key=code/fn.zip \
  --memory-size 1024 --timeout 60 --environment "Variables={MODE=bundle}"
```

Container image variant (same build directory):

```dockerfile
FROM public.ecr.aws/lambda/nodejs:22
COPY build/ ${LAMBDA_TASK_ROOT}/
CMD ["index.handler"]
```
Built with `docker buildx build --provenance=false --platform linux/arm64 --push`, function created with `--package-type Image`.

Sizes:

| Package | Zip size | Unzipped |
|---|---|---|
| arm64, DuckDB only | 25.9 MB | 98 MB |
| arm64, DuckDB + 3 extensions | 58.2 MB | 202 MB |
| x86_64, DuckDB + 3 extensions | 62.9 MB | 202 MB |

Limits: DuckDB-only zip fits direct upload (50 MB); with the three extensions the zip exceeds 50 MB (S3 upload needed) and the unzipped size is 202 of 250 MB, leaving about 48 MB headroom (adding aws would add about 20 MB more compressed, probably more than 50 MB unpacked; not measured). Extension downloads at runtime (gz): httpfs 8.6 MB, avro 7.6 MB, iceberg 16.2 MB (arm64); unpacked on disk 26.5 + 27.1 + 55.5 = about 109 MB in /tmp.

## Extension settings

Runtime install into /tmp (works):
`DuckDBInstance.create(':memory:', { home_directory: '/tmp/duckhome', extension_directory: '/tmp/duckext' })` then `INSTALL x; LOAD x;`. Without `home_directory` the instance fails: `IO Error: Can't find the home directory at ''. Specify a home directory using the SET home_directory='/path/to/dir' option.` With a read-only extension_directory: `IO Error: Failed to create directory "/nonexistent-ro": Read-only file system`.

Bundled (works, no network):
`{ home_directory: '/tmp/duckhome', extension_directory: '/var/task/ext', autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' }` then `LOAD httpfs; LOAD avro; LOAD iceberg;` by name. The directory layout must be `<extension_directory>/v2.0.0/linux_arm64/<name>.duckdb_extension` (version dir then platform dir). `LOAD '/var/task/ext/v2.0.0/linux_arm64/x.duckdb_extension'` by explicit path also works on a fresh instance. The `.info` files that INSTALL writes are not needed. Signed official binaries load without `allow_unsigned_extensions`. Platform check works and gives a clear error (tested in a local linux/arm64 container): `The file was built for the platform 'linux_amd64', but we can only load extensions built for platform 'linux_arm64'.` A corrupt file gives `The file is not a DuckDB extension. The metadata at the end of the file is invalid`. A missing path gives `Extension "<path>" not found`.

Credentials for S3 via httpfs:
- `CREATE SECRET (TYPE s3, PROVIDER credential_chain, REGION 'ap-northeast-1')` requires the `aws` extension. With autoload disabled it fails: `Secret provider "credential_chain" for type "s3" does not exist, but it exists in the aws extension.` With autoinstall on (runtime-install function) it autoinstalled aws and worked, but the CREATE SECRET call cost 1258 ms.
- Env-based secret works with httpfs only and costs 1 to 2 ms: `CREATE SECRET (TYPE s3, REGION 'ap-northeast-1', KEY_ID '<AWS_ACCESS_KEY_ID>', SECRET '<AWS_SECRET_ACCESS_KEY>', SESSION_TOKEN '<AWS_SESSION_TOKEN>')` built from the Lambda environment variables. Recommended for the bundle (credentials rotate per execution environment, so create the secret at init, or per invocation if the session token may expire in a long-lived environment).

## Handler deployed

```js
import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync } from 'node:fs';

const T0 = Date.now();
const MODE = process.env.MODE || 'plain'; // plain | bundle | install
const BUCKET = process.env.BUCKET || '';
const EXTS = ['httpfs', 'avro', 'iceberg'];
const initInfo = { mode: MODE, steps: {} };

async function time(label, fn) {
  const t = Date.now();
  try { await fn(); initInfo.steps[label] = Date.now() - t; }
  catch (e) { initInfo.steps[label] = 'ERR: ' + e.message; }
}

const opts = { home_directory: '/tmp/duckhome' };
if (MODE === 'bundle') {
  opts.extension_directory = '/var/task/ext';
  opts.autoinstall_known_extensions = 'false';
  opts.autoload_known_extensions = 'false';
} else if (MODE === 'install') {
  opts.extension_directory = '/tmp/duckext';
}
let instance, conn;
await time('create', async () => {
  instance = await DuckDBInstance.create(':memory:', opts);
  conn = await instance.connect();
});
if (MODE !== 'plain') {
  for (const e of EXTS) {
    await time('load_' + e, async () => {
      if (MODE === 'install') await conn.run(`INSTALL ${e}`);
      await conn.run(`LOAD ${e}`);
    });
  }
}
initInfo.initTotalMs = Date.now() - T0;
let invocations = 0;
const q = async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson();

export const handler = async (event = {}) => {
  invocations++;
  const out = { invocations, initInfo, mem: process.memoryUsage().rss >> 20 };
  const test = event.test || 'version';
  const t = Date.now();
  try {
    if (test === 'version') {
      out.r = await q(`select version() v, (select platform from pragma_platform()) p, current_setting('threads') threads, current_setting('memory_limit') memlimit, current_setting('extension_directory') extdir, current_setting('home_directory') home`);
      out.sum = await q('select sum(i) s from range(1000000) t(i)');
      out.exts = await q(`select extension_name, extension_version, loaded, installed, install_path from duckdb_extensions() where installed and install_path <> '(BUILT-IN)'`);
    } else if (test === 'loadpath') {
      for (const e of EXTS) await conn.run(`LOAD '/var/task/ext/v2.0.0/linux_${process.arch === 'arm64' ? 'arm64' : 'amd64'}/${e}.duckdb_extension'`);
      out.r = 'loaded by path';
    } else if (test === 'sql') {
      out.r = await q(event.sql);
    } else if (test === 'fs') {
      out.r = { var_task_writable: await q(`select 1`).then(() => 0) };
    } else if (test === 'fresh') {
      const plat = process.arch === 'arm64' ? 'arm64' : 'amd64';
      const other = process.arch === 'arm64' ? 'amd64' : 'arm64';
      const inst = await DuckDBInstance.create(':memory:', { home_directory: '/tmp/duckhome2', autoinstall_known_extensions: 'false', autoload_known_extensions: 'false', extension_directory: '/nonexistent-ro' });
      const c2 = await inst.connect();
      out.byPath = {};
      for (const e of EXTS) {
        const s = Date.now();
        try { await c2.run(`LOAD '/var/task/ext/v2.0.0/linux_${plat}/${e}.duckdb_extension'`); out.byPath[e] = Date.now() - s; } catch (x) { out.byPath[e] = 'ERR ' + x.message; }
      }
      try { await c2.run(`LOAD '/var/task/ext/v2.0.0/linux_${other}/httpfs.duckdb_extension'`); out.wrongPlatform = 'loaded?!'; } catch (x) { out.wrongPlatform = x.message; }
      try { await c2.run(`INSTALL aws`); out.installRO = 'ok?!'; } catch (x) { out.installRO = x.message; }
    } else if (test === 'nohome') {
      try { const inst = await DuckDBInstance.create(':memory:'); const c2 = await inst.connect(); await c2.run('INSTALL httpfs'); out.nohome = 'ok?!'; } catch (x) { out.nohome = x.message; }
    } else if (test === 'reinstall') {
      const s = Date.now(); await conn.run('INSTALL httpfs'); await conn.run('INSTALL avro'); out.reinstallMs = Date.now() - s;
      out.tmpdf = await q(`select count(*) n from glob('/tmp/duckext/*/*/*')`);
    } else if (test === 'parquet' || test === 's3') {
      const tt = {};
      let s = Date.now();
      await conn.run(`create or replace table ev as select i id, now() - to_seconds(i) ts, 'proj' || (i % 20) project, (['error','warning','info','fatal'])[1 + i % 4] level, 'Exception number ' || (i % 977) || ' in module ' || (i % 31) message, repeat('x', 200 + i % 300) payload from range(50000) t(i)`);
      tt.create = Date.now() - s; s = Date.now();
      await conn.run(`copy ev to '/tmp/ev.parquet' (format parquet)`);
      tt.write_tmp = Date.now() - s; s = Date.now();
      out.agg_tmp = await q(`select level, count(*) c, count(distinct message) d from '/tmp/ev.parquet' group by 1 order by 1`);
      tt.read_tmp = Date.now() - s;
      if (test === 's3') {
        s = Date.now();
        const sec = event.secret || 'chain';
        if (sec === 'chain') await conn.run(`create or replace secret s (type s3, provider credential_chain, region 'ap-northeast-1')`);
        else await conn.run(`create or replace secret s (type s3, region 'ap-northeast-1', key_id '${process.env.AWS_ACCESS_KEY_ID}', secret '${process.env.AWS_SECRET_ACCESS_KEY}', session_token '${process.env.AWS_SESSION_TOKEN}')`);
        tt.secret = Date.now() - s; s = Date.now();
        const url = `s3://${BUCKET}/spike/ev-${invocations}.parquet`;
        await conn.run(`copy ev to '${url}' (format parquet)`);
        tt.write_s3 = Date.now() - s; s = Date.now();
        out.agg_s3 = await q(`select level, count(*) c from '${url}' group by 1 order by 1`);
        tt.read_s3 = Date.now() - s; s = Date.now();
        // streaming read
        const res = await conn.stream(`select * from '${url}'`);
        let rows = 0, chunks = 0;
        for await (const batch of res.yieldRowObjectJson()) { rows += batch.length; chunks++; }
        tt.stream_s3 = Date.now() - s;
        out.stream = { rows, chunks };
      }
      out.timings = tt;
    }
  } catch (e) { out.error = String(e && e.message || e); }
  out.testMs = Date.now() - t;
  out.rssMB = process.memoryUsage().rss >> 20;
  return out;
};
```

## Results

All times in ms. "Init" is the INIT_REPORT / REPORT `Init Duration` (includes runtime bootstrap, module load and the top-level await that creates the instance and loads extensions). 3 forced cold starts per cell (env var change), values listed individually. Handler work for the "version" test (select version() + sum over 1M rows) is 20 to 60 ms warm. A "timeout" cold start means init exceeded the 10 s init limit; Lambda then re-ran init inside the invoke, so the user-visible latency was Init (10 s) plus the retry (see below).

| Config (arm64) | 512 MB | 1024 MB | 2048 MB |
|---|---|---|---|
| ZIP, DuckDB only: Init | 616, 646, 636 | 669, 868, 705 | 694, 647, 668 |
| ZIP, DuckDB only: first-invoke Duration | 193, 195, 196 | 112, 95, 76 | 54, 48, 50 |
| ZIP, bundle in /var/task, 3 exts: Init | 4208, 4146, timeout | timeout, 5357, 4297 | 4191, timeout, timeout |
| ZIP, runtime INSTALL to /tmp, 3 exts: Init | 4079, 2841, 3379 | 3214, 3502, 2620 | 2929, 2574, 2934 |
| Container, bundle in /var/task, 3 exts: Init | 1305, 2290, 1635 | 1330, 1223, 1411, 1213, 1525 | 1813, 1659, 1846 |

Warm invocation (version test): 9 to 15 ms at 1024/2048 MB, 15 to 40 ms at 512 MB, for every configuration (arm64 DuckDB only 10 to 13 ms at 1024).

Other numbers:
- Bundle loads inside init (ZIP, /var/task): httpfs 0.5 s, avro 0.6 to 5 s, iceberg 1.3 to 13 s; init exceeded the 10 s limit in 4 of 9 arm64 cold starts (plus the very first deployed invocation) and 2 of 3 x86_64 ones (observed total in-handler init up to 19 s, 9.7 s, 6.1 s). Very erratic. x86_64 ZIP bundle at 1024 MB: Init 7986, timeout (4.7 s of work then retry), timeout (12.9 s), with iceberg load 1.5 to 8.1 s.
- Runtime install in /tmp (ZIP): per-extension time httpfs 0.44 to 0.8 s, avro 0.45 to 0.8 s, iceberg 0.8 to 1.6 s (download + write + load); total 2.1 to 3.4 s in the init phase. Re-running `INSTALL httpfs; INSTALL avro` when the files are already in /tmp: 1 ms (no download).
- Container bundle load per extension: httpfs 130 to 220 ms, avro 140 to 290, iceberg 270 to 540; instance creation 77 to 118 ms (but the very first cold start after deploying the image was 5.5 s, instance creation 2.2 s, then it settled to about 1.3 s: image chunks are cached after first use).
- Memory (Max Memory Used, REPORT): DuckDB only 155 to 160 MB; ZIP bundle 275 to 285 MB; runtime install 340 to 400 MB (page cache / downloads in /tmp counted); container bundle 270 MB. DuckDB `memory_limit` default is 80 percent of the function memory (924 MiB at 1024 MB) and `threads` is 2 at all tested sizes (512 to 2048 MB; the 2 vCPU of Lambda at 1769+ MB; threads stayed 2).
- x86_64 (ZIP, DuckDB only and extensions) loads fine too: `linux_amd64`, same versions.

Parquet and S3 smoke test (50,000 rows with a 200 to 500 byte payload string column, 20 projects, 4 levels; arm64):

| Step | ZIP/install 2048 MB | Container 1024 MB | Container 512 MB |
|---|---|---|---|
| create table (generated) | 59 to 81 | 93 | 205 |
| COPY to /tmp parquet | 49 to 79 | 61 | 135 |
| aggregate from /tmp parquet | 20 to 36 | 37 | 60 |
| env secret create | 1 | 1 | 1 |
| COPY to s3:// parquet (httpfs, role credentials) | 112 to 193 | 105 | 181 |
| aggregate read back from s3:// | 51 to 56 | 50 | 54 |
| full streaming read of 50,000 rows (yieldRowObjectJson) | 405 to 622 | 663 | 1563 |
| whole invocation Duration | 985 (env) / 1962 (chain, incl. aws autoinstall 1258) | 1231 | 2270 |
| Max Memory Used | 443 to 627 MB | 440 MB | 390 MB |

All smoke tests returned correct counts (12,500 per level). The S3 write and read round trips work with the function role through httpfs only; the aws extension is needed only for `credential_chain`.

## What failed or surprised

1. Loading bundled extensions from `/var/task` in a ZIP function is slow and highly variable (extension files are paged in lazily from the code package, and DuckDB reads the whole file when loading): iceberg alone took 1.3 to 13 s, and roughly half of the cold starts exceeded the 10 s init limit, after which Lambda retries init in the invoke phase (billed, and the REPORT showed 5 to 20 s invocations). This is the opposite of what one expects from "no network download". Runtime INSTALL from /tmp was faster and steadier (2.1 to 3.4 s). The same file set in a container image was fastest and steady (about 1.2 to 1.8 s init), except for the first cold start after deploy (5.5 s).
2. `credential_chain` needs the `aws` extension (error text above); not bundled in the test.
3. No `home_directory` gives a hard error even for bundle mode on the read-only filesystem; set it to /tmp.
4. The `.mjs`/ESM requirement (CJS require fails).
5. ZIP with three extensions exceeds the 50 MB direct upload and uses 202 of 250 MB unzipped.
6. Streaming API: `connection.stream(sql)` returns a `DuckDBResult` with `yieldRowObjectJson()` (also `yieldRows`, `yieldRowObjects`, `fetchChunk()`); results arrive in 2048-row chunks (25 chunks for 50,000 rows). Converting rows to JS/JSON objects dominates: 400 to 660 ms for 50k rows at 1024 to 2048 MB and 1.6 s at 512 MB, so use SQL aggregation or `COPY` for bulk work and keep JS row conversion for small results. `runAndReadAll(...).getRowObjectsJson()` is the simple path for small results. Int64 and decimal values come back as strings in the JSON variants.
7. Extension signature checking: only signed official binaries were used; behaviour for unsigned or version-mismatched extensions was not tested beyond the platform and corruption errors above (the version directory `v2.0.0` is part of the path).
8. Reusing the execution environment: after init the instance and loaded extensions persist across invocations (invocation counter 1 to 5 observed, extensions still loaded); re-INSTALL is a 1 ms no-op because the files stay in /tmp. A new execution environment starts with an empty /tmp, so INSTALL downloads again every cold start.
9. glibc: the Linux binaries ran on Lambda's Amazon Linux 2023 runtime without any glibc problem (the container image reports glibc 2.34); only the glibc package variant is usable (not `-musl`).

## Recommendation

- Use a container image (public.ecr.aws/lambda/nodejs:22, arm64) with the DuckDB bindings and the extension files baked in under `/var/task/ext/v2.0.0/linux_arm64/`, and load with `extension_directory` pointed there, `autoinstall_known_extensions=false`, `autoload_known_extensions=false`, `home_directory=/tmp/<dir>`. Measured init about 1.2 to 1.8 s (first cold start after a deploy may be about 5 s), no network, no signature trouble.
- If ZIP is required, prefer runtime INSTALL into /tmp (2 to 3.5 s init, needs egress to extensions.duckdb.org, no 50 MB trouble) over bundling in /var/task, whose init variance risks the 10 s init timeout. Loading only the extensions a given function needs (for example drop avro or httpfs where unneeded) reduces both options. A Lambda layer was not measured but uses the same lazy-paged file storage as the ZIP, so expect ZIP-like variance (inference).
- Memory: 1024 MB is a reasonable default (init and warm time level off; 2 threads regardless; the 50k-row Parquet round trip needs about 440 MB). 512 MB works but is 2 to 3 times slower for CPU-bound work. Set `memory_limit` explicitly below the function memory if Lambda memory is tight, and keep `threads` at 2 (or leave default).
- Use the env-based S3 secret (no aws extension) or bundle `aws` if the chain provider is wanted.
- Create the instance and load extensions once at module init (top-level await) and reuse the connection across warm invocations.

## Untested

- Any Iceberg catalog, S3 Tables, Lakekeeper, actual iceberg/avro reads or writes (only `LOAD`)
- Lambda layers, provisioned concurrency / SnapStart-like warming, ephemeral storage above 1024 MB, `/tmp` use near its limit
- Unsigned extensions and `allow_unsigned_extensions`; the `aws` extension in bundle mode
- x86_64 container image; ZIP with fewer extensions to see whether iceberg alone avoids the init timeout
- Concurrent invocations in one environment (Lambda runs one at a time per environment), large-result streaming (millions of rows), and higher DuckDB versions or the 1.4.x LTS line
- Cold-start numbers are samples of 3 (5 for the container at 1024 MB); variance in the ZIP bundle case is large enough that more samples would be needed for percentiles
