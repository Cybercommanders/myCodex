#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const eslint = spawn("npm", ["run", "lint"], { stdio: "inherit" });

eslint.on("close", (code) => {
  process.exitCode = code;
});
