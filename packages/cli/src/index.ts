#!/usr/bin/env node
import { cliMain } from './main';
// 等待 runner 清理与报告落盘，不使用 process.exit 强制截断 finally。
process.exitCode = await cliMain(process.argv.slice(2));
