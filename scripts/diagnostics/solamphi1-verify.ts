/** Native BSP checks: run with npx vite-node src/games/fps/scripts/diagnostics/solamphi1-verify.ts. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createBotVision} from '../../bot/BotVision';
import {Contents, MASK_LIQUID} from '../../../../shared/collision/CollisionWorld';
import {q3ToBabylon} from '../../../../engine/loader/bsp/mesh/coordinates';
import {BspLoader} from '../../../../engine/loader/bsp/BspLoader';
import {resolveMapBspViaIndex} from '../../../../engine/loader/pk3/NodePk3';

const q=(x:number,y:number,z:number)=>{const p=q3ToBabylon(x,y,z);return {x:p[0],y:p[1],z:p[2]};};
const vision=await createBotVision('solamphi1');
assert(vision,'Published map must load through the index');
const world=vision.collisionWorld;
const bounds={min:{x:-16,y:-24,z:-16},max:{x:16,y:40,z:16}};
const tunnels=[world.trace(q(0,-240,24.5),q(0,240,24.5),bounds),world.trace(q(-240,0,24.5),q(240,0,24.5),bounds)];
for(const trace of tunnels)assert.equal(trace.fraction,1,'Standing hull must cross the reactor underpass');
const basins=[];
for(const sx of[-1,1])for(const sy of[-1,1]){
 const contents=world.pointContents(q(sx*580,sy*580,-20));
 assert(contents&Contents.SLIME,'Each basin must contain actual slime');
 const steps=[372,348,324,300].map((x,i)=>{
  const trace=world.trace(q(sx*x,sy*480,64),q(sx*x,sy*480,-80));
  assert(trace.hitPoint,'Escape step must have a floor');
  assert(Math.abs(trace.hitPoint.y-[-32,-20,-8,0][i])<.5,'Escape stair height');
  assert((trace.normal?.y??0)>.99,'Escape stair must be walkable');
  return trace.hitPoint.y;
 });
 basins.push({sx,sy,contents,steps});
}
for(const p of[q(0,-240,.5),q(720,0,.5)])assert.equal(world.pointContents(p)&MASK_LIQUID,0,'Main paths must remain dry');
const bytes=await resolveMapBspViaIndex(['public/data'],'solamphi1');assert(bytes);
const bsp=BspLoader.load(bytes);
// MakeBSP consumes the DETAIL bit during construction; final material flags
// are shared by structural and detail brushes. Test an authored detail pilaster.
const detailPilaster=world.trace(q(-800,-720,100),q(-832,-720,100));
assert(detailPilaster.hitPoint&&detailPilaster.hit,'Detail pilaster must remain solid');
assert(Math.abs(detailPilaster.hitPoint.x+816)<.5,'Detail pilaster must stop traces at its actual face');
assert(world.pointContents(q(-828,-720,100))&Contents.SOLID,'Detail brush interior must remain solid');
assert(bsp.faces.some(f=>bsp.textures[f.textureIndex]?.name.includes('decals/fonts/relay_yard')),'Native lettering must be baked');
const report={ok:true,tunnels,basins,detailPilaster,brushes:bsp.brushes.length,faces:bsp.faces.length};
fs.writeFileSync('experiments/shagged/solamphi1/refinement/collision-report.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
