#!/usr/bin/env tsx
import { run, defineCommand } from "@/lib/cli/cli";
import { selectliveCommand } from "./selectlive/commands";
import { runSelectlive } from "./selectlive/handlers";
export const cmd = defineCommand(selectliveCommand);
run(cmd, runSelectlive, import.meta.url);
