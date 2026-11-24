import { MemoryActiveStore } from "./memory-active.js";
import { rateRejectionPipelineSuite } from "./rate-rejection-pipeline.js";

rateRejectionPipelineSuite("memory", async () => new MemoryActiveStore());
