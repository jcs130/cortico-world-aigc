import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
it('executes the cross-World pipeline in real Node against official Cortico, including Unicode paths',()=>{
 const output=execFileSync(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixtures/core-flow.ts',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:15000});
 expect(JSON.parse(output.trim().split('\n').at(-1)!)).toMatchObject({passed:true,delivered:1,actualNetworkCalls:0});
},20000);
