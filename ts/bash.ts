import {
  createBashTool as createPiBashTool,
  createBashToolDefinition as createPiBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createShellMuxOperations } from "./operations.js";

export const createBashTool: typeof createPiBashTool = (cwd, options) =>
  createPiBashTool(cwd, {
    ...options,
    operations: options?.operations ?? createShellMuxOperations(),
  });

export const createBashToolDefinition: typeof createPiBashToolDefinition = (cwd, options) =>
  createPiBashToolDefinition(cwd, {
    ...options,
    operations: options?.operations ?? createShellMuxOperations(),
  });
