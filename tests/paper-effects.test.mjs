import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OfficeScene } from '../src/office-scene.ts';
import { paperPlaneCurve, paperPlaneMessageCurve, paperPlaneScale, foldedPaperPlane } from '../src/office-effects.ts';

// Use the real flight methods and geometry without a browser, canvas or WebGL context.
function fixture() {
  const figures = ['sender','receiver'].map((id,index)=>{
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(1,.6),new THREE.MeshBasicMaterial());
    screen.position.set(index*8,1.9,0);
    return {id,seat:index,group:new THREE.Group(),screen};
  });
  return Object.assign(Object.create(OfficeScene.prototype),{
    figures,agentSeats:new Map(figures.map((figure,index)=>[figure.id,index])),
    paperFlights:[],seenPlaneEvents:new Set(),effects:new THREE.Group(),reducedMotion:false,disposed:false,
    camera:new THREE.OrthographicCamera(-13,13,10,-10,.1,150),container:{clientHeight:800},
  });
}

test('simultaneous real messages follow distinct readable paths from their actual computers',()=>{
  const scene=fixture();
  for(let index=0;index<6;index++)assert.equal(scene.sendPaperPlane('sender','receiver',`event-${index}`),true);
  const starts=scene.figures.map(figure=>figure.screen.getWorldPosition(new THREE.Vector3()));
  const midpoints=new Set();
  for(const flight of scene.paperFlights){
    assert.ok(flight.curve.getPoint(0).equals(starts[0]));
    assert.ok(flight.curve.getPoint(1).equals(starts[1]));
    midpoints.add(flight.curve.getPoint(.5).toArray().join(','));
    assert.ok(flight.duration>=3.6 && flight.duration<=7);
    assert.ok(flight.plane.getObjectByName('handoff-paper-crease'));
    assert.equal(flight.trail.visible,false);
  }
  assert.equal(midpoints.size,6,'a burst must not stack every plane on the same arc');
  scene.updatePaperFlights(1);
  for(const flight of scene.paperFlights){
    assert.equal(flight.trail.visible,true);
    const positions=flight.trail.geometry.getAttribute('position');
    const tip=flight.trail.localToWorld(new THREE.Vector3().fromBufferAttribute(positions,positions.count-1));
    assert.ok(tip.distanceTo(flight.plane.position)<1e-5,'the trail remains attached after plane rotation and scaling');
  }
  for(const flight of [...scene.paperFlights])scene.removePaperFlight(flight);
});

test('all camera framings retain a hand-sized plane without reallocating trail geometry',()=>{
  const scene=fixture();scene.sendPaperPlane('sender','receiver','wide');
  const flight=scene.paperFlights[0],trailGeometry=flight.trail.geometry;
  for(const zoom of [.02,.4,1,4,100]){
    scene.camera.zoom=zoom;scene.updatePaperFlights(.1);
    assert.equal(flight.plane.scale.x,.4);
    assert.ok(Math.abs(flight.plane.scale.x*.52-.208)<1e-9);
  }
  assert.equal(flight.trail.geometry,trailGeometry);
  for(const scale of [-Infinity,-1,0,.001,.1,10,Infinity,NaN,undefined])assert.equal(paperPlaneScale(scale),.4);
  scene.removePaperFlight(flight);
});

test('newly created plane geometry already has the fixed hand-sized length before its first frame',()=>{
  const plane=foldedPaperPlane();
  const size=new THREE.Box3().setFromObject(plane).getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.z-.208)<1e-6);
  assert.ok(size.x<.21 && size.y<.21);
  plane.traverse(child=>{
    if(child.geometry)child.geometry.dispose();
    for(const material of child.material?Array.isArray(child.material)?child.material:[child.material]:[])material.dispose();
  });
});

function assertOneHorizontalLoop(curve){
  const first=curve.getPoint(.25),opposite=curve.getPoint(.5);
  const center=first.clone().lerp(opposite,.5),radius=first.distanceTo(center);
  assert.ok(radius>.3,'the loop is visible rather than a negligible wobble');
  let angle=0;
  for(let i=0;i<200;i++){
    const current=curve.getPoint(.25+i/400),next=curve.getPoint(.25+(i+1)/400);
    assert.ok(Math.abs(current.y-center.y)<1e-9,'the circle remains horizontal');
    assert.ok(Math.abs(current.distanceTo(center)-radius)<1e-9);
    const a=Math.atan2(current.z-center.z,current.x-center.x),b=Math.atan2(next.z-center.z,next.x-center.x);
    angle+=Math.atan2(Math.sin(b-a),Math.cos(b-a));
  }
  assert.ok(Math.abs(Math.abs(angle)-Math.PI*2)<1e-9,'the flight makes exactly one complete turn');
  assert.ok(curve.getPoint(.75).distanceTo(first)<1e-9,'the circular section closes before departure');
}

test('handoffs preserve real endpoints and monitor directions around one complete horizontal loop',()=>{
  const start=new THREE.Vector3(-8,1.9,3),end=new THREE.Vector3(7,35.2,-4);
  const from=new THREE.Vector3(1,0,1).normalize(),to=new THREE.Vector3(-1,0,1).normalize();
  const originals=[start,end,from,to].map(vector=>vector.toArray());
  const midpointKeys=new Set();
  for(let lane=0;lane<32;lane++){
    const curve=paperPlaneCurve(start,end,from,to,lane);
    assert.ok(curve instanceof THREE.Curve);
    assert.ok(curve.getPoint(0).equals(start));assert.ok(curve.getPoint(1).equals(end));
    assert.ok(curve.getTangent(0).dot(from)>.999999);
    assert.ok(curve.getTangent(1).dot(to.clone().negate())>.999999);
    assertOneHorizontalLoop(curve);
    midpointKeys.add(curve.getPoint(.5).toArray().join(','));
    for(let i=0;i<=400;i++){
      const point=curve.getPoint(i/400),tangent=curve.getTangent(i/400);
      assert.ok([...point,...tangent].every(Number.isFinite));
      assert.ok(point.y>=start.y-1e-9,'a cross-floor route never dips below its lower monitor');
      assert.ok(Math.abs(tangent.length()-1)<1e-9);
    }
    assert.ok(Number.isFinite(curve.getLength()) && curve.getLength()>start.distanceTo(end));
  }
  assert.equal(midpointKeys.size,32,'simultaneous lanes remain distinct');
  assert.deepEqual([start,end,from,to].map(vector=>vector.toArray()),originals,'caller-owned computer transforms remain unchanged');
});

test('circle joins have continuous positions, tangents and speed even across different floors',()=>{
  for(const curve of [paperPlaneCurve(new THREE.Vector3(-4,2,0),new THREE.Vector3(8,42,-2),new THREE.Vector3(1,0,1),new THREE.Vector3(-1,0,0),31),
    paperPlaneMessageCurve(new THREE.Vector3(0,2,0),new THREE.Vector3(0,0,1),15)]){
    for(const join of [.25,.75]){
      const h=1e-6,at=curve.getPoint(join);
      const incoming=at.clone().sub(curve.getPoint(join-h)).divideScalar(h);
      const outgoing=curve.getPoint(join+h).sub(at).divideScalar(h);
      assert.ok(incoming.distanceTo(outgoing)/incoming.length()<.001,'joining segments must not snap in direction or speed');
      assert.ok(curve.getTangent(join-h).dot(curve.getTangent(join+h))>.999999);
      assert.ok(at.distanceTo(curve.getPoint(join-h))<.001 && at.distanceTo(curve.getPoint(join+h))<.001);
    }
  }
});

test('recipient-free messages return to their own computer through a compact forward loop',()=>{
  const start=new THREE.Vector3(12,3,-5),normal=new THREE.Vector3(-1,0,1).normalize();
  const lanes=new Set();
  for(let lane=0;lane<32;lane++){
    const curve=paperPlaneMessageCurve(start,normal,lane);
    assert.ok(curve.getPoint(0).equals(start));assert.ok(curve.getPoint(1).equals(start));
    assert.ok(curve.getTangent(0).dot(normal)>.999999);
    assert.ok(curve.getTangent(1).dot(normal.clone().negate())>.999999);
    assertOneHorizontalLoop(curve);lanes.add(curve.getPoint(.5).toArray().join(','));
    for(let i=0;i<=200;i++){
      const point=curve.getPoint(i/200);
      assert.ok(point.distanceTo(start)<3,'a local message stays near its own computer');
      assert.ok(point.clone().sub(start).dot(normal)>-1e-9,'a local message stays in front of its monitor');
    }
  }
  assert.equal(lanes.size,32);
});

test('coincident endpoints, zero normals and exceptional lane/progress inputs stay finite',()=>{
  const start=new THREE.Vector3(0,2,0),normal=new THREE.Vector3();
  for(const lane of [-100,NaN,Infinity,32,1e20]){
    for(const curve of [paperPlaneCurve(start,start,normal,normal,lane),paperPlaneMessageCurve(start,normal,lane)]){
      for(const time of [NaN,Infinity,-1,0,.125,.25,.5,.75,.9,1,2]){
        assert.ok([...curve.getPoint(time),...curve.getTangent(time)].every(Number.isFinite));
      }
      const target=new THREE.Vector3();
      assert.equal(curve.getPoint(.5,target),target);
      assert.equal(curve.getTangent(.5,target),target);
      assertOneHorizontalLoop(curve);
    }
  }
});

test('flight completion and reduced motion release outline and trail resources with the original meshes',()=>{
  const scene=fixture();scene.sendPaperPlane('sender','receiver','cleanup');
  const flight=scene.paperFlights[0],geometries=[],materials=[],disposed=[];
  for(const root of [flight.plane,flight.arrival])root.traverse(child=>{
    if(!child.geometry)return;
    geometries.push(child.geometry);
    child.geometry.addEventListener('dispose',()=>disposed.push(child.geometry));
    for(const material of Array.isArray(child.material)?child.material:[child.material]){
      materials.push(material);material.addEventListener('dispose',()=>disposed.push(material));
    }
  });
  scene.updatePaperFlights(flight.duration+.81);
  assert.equal(scene.paperFlights.length,0);assert.equal(scene.effects.children.length,0);
  assert.equal(disposed.length,geometries.length+materials.length);
  assert.equal(new Set(disposed).size,disposed.length);
  scene.reducedMotion=true;scene.sendPaperPlane('sender','receiver','reduced');
  assert.equal(scene.paperFlights[0].plane.visible,false);
  assert.equal(scene.paperFlights[0].trail.visible,false);
  assert.equal(scene.paperFlights[0].arrival.visible,true);
  scene.updatePaperFlights(.81);assert.equal(scene.effects.children.length,0);
});
