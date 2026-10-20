import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
const root = resolve(process.argv[2] ?? '.');
const walk = dir => readdirSync(dir,{withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(resolve(dir,e.name)) : [resolve(dir,e.name)]);
const files = walk(resolve(root,'src')).filter(f=>/\.ts$/.test(f));
const graph = new Map(files.map(f=>[f,[]]));
let edges=0;
for(const file of files) {
  const local = relative(root,file).replaceAll('\\','/'), source = ts.createSourceFile(file,readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true);
  const neutral = local!=='src/index.ts' && local!=='src/config.ts';
  const edge=(specifier,typeOnly)=>{
    if(neutral && /^(?:cortico(?:\/|$)|cortico-world-|agent-mc-world(?:\/|$)|neko(?:\/|$))/.test(specifier))
      throw Error('Neutral module imports a host/World: '+local+' -> '+specifier);
    if(!specifier.startsWith('.')) return;
    const target = resolve(dirname(file),specifier.replace(/\.js$/,'.ts'));
    if(neutral && ['src/index.ts','src/config.ts'].includes(relative(root,target).replaceAll('\\','/')))
      throw Error('Neutral module imports its adapter: '+local);
    if(!typeOnly && graph.has(target)) { graph.get(file).push(target); edges++; }
  };
  const visit=node=>{
    if(ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) edge(node.moduleSpecifier.text,node.importClause?.isTypeOnly===true);
    else if(ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) edge(node.moduleSpecifier.text,node.isTypeOnly);
    else if(ts.isCallExpression(node) && node.expression.kind===ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) edge(node.arguments[0].text,false);
    ts.forEachChild(node,visit);
  };visit(source);
}
const done=new Set(),active=new Set(),stack=[];
const visit=file=>{
  if(active.has(file)) throw Error('Runtime import cycle: '+[...stack,file].map(f=>relative(root,f)).join(' -> '));
  if(done.has(file)) return;
  active.add(file);stack.push(file);for(const target of graph.get(file)) visit(target);stack.pop();active.delete(file);done.add(file);
};for(const file of files)visit(file);
console.log(JSON.stringify({schema:'agent-module-boundaries/v1',root,sourceFiles:files.length,runtimeEdges:edges,reverseImports:0,runtimeCycles:0}));
