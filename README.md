<p align="center">
  <img src="public/openscreen.png" alt="OpenScreen" width="72" />
</p>

<h1 align="center">OpenScreen</h1>

<p align="center">A free desktop recorder and editor for sharp product demos, guides, and clips.</p>

<p align="center">
  <img src="public/sample.png" alt="OpenScreen editor with video effects and timeline controls" width="100%" />
</p>

This fork keeps the OpenScreen project format and editor features while adding webcam-only recording, full-source-resolution screen capture, lower memory use for long recordings, and direct-to-disk MP4 export.

## Quickstart

Requires Node.js 22.22.1 and npm 10.9.4.

```bash
git clone git@github.com:joey-david/openscreen.git
cd openscreen
npm install
npm run dev
```

Build an installer with `npm run build:mac`, `npm run build:win`, or `npm run build:linux`.

## Benchmarks

Measured on an Apple silicon MacBook Air with 16 GiB RAM, macOS 26.5.2, and Node.js 22.23.1. Results compare upstream commit `f57e36e` with this fork using a synthetic 256 MiB file; each value is the median of three fresh child processes.

| Path | Before time | After time | Speedup | Before peak RSS | After peak RSS | RSS drop |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Finish streamed WebM with no duration field | 155.2 ms | 49.5 ms | 3.1× | 1,594 MiB | 61 MiB | 96% |
| Export unchanged MP4 | 118.3 ms | 67.3 ms | 1.8× | 1,338 MiB | 57 MiB | 96% |

Peak RSS is the full worker process, not JavaScript heap use alone. Re-run the comparison with:

```bash
npm run benchmark -- --size-mib 256 --runs 3
```

Based on [siddharthvaddem/openscreen](https://github.com/siddharthvaddem/openscreen) and released under the [MIT License](./LICENSE).
