import { readFileSync, writeFileSync } from 'node:fs';
import { buildMiniMaxH3Workflow } from '../dist/core/comfy-minimax-h3.js';
const [optionsFile, outputFile] = process.argv.slice(2);
if (!optionsFile || !outputFile) throw Error('Usage: node scripts/create-h3-workflow.mjs <operator-models.json> <workflow.json>');
const workflow = buildMiniMaxH3Workflow(JSON.parse(readFileSync(optionsFile, 'utf8')));
writeFileSync(outputFile, JSON.stringify(workflow, null, 2) + '\n');
console.log(JSON.stringify({ schema: workflow.schema, outputFile, profiles: [...new Set(workflow.variants.map(v => v.profile))], referenceCounts: [...new Set(workflow.variants.map(v => v.requiredReferences))] }));
