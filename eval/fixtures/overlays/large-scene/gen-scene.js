// gen-scene.js — large-scene overlay (v0.18.0 eval fixture).
//
// Writes a full Main.unity with 500 enemy objects (Enemy_000 ..
// Enemy_499) under Level/Enemies, each with the Enemy component,
// plus the base objects (Player, Floor, Level, EvalProbe). The
// find-edit-500 task is: find Enemy_042 in this crowd and set its
// health — it tests list_hierarchy + context use, not patience.
// Plain Node, required by the main process during fixture setup;
// generate(projectDir) writes Assets/Scenes/Main.unity.
'use strict';
const fs = require('fs');
const path = require('path');

const ENEMY_GUID = '20050388771a03927d76ae9ac8c82567';
const PLAYER_GUID = '515dcb1fa9f98c022d7694234c6ac93a';
const PROBE_GUID = '479718cc20e751ff870279b926563120';
const COUNT = 500;

function gameObject(id, transformId, name, extraComponents) {
  let s = '--- !u!1 &' + id + '\nGameObject:\n'
    + '  m_ObjectHideFlags: 0\n'
    + '  m_CorrespondingSourceObject: {fileID: 0}\n'
    + '  m_PrefabInstance: {fileID: 0}\n'
    + '  m_PrefabAsset: {fileID: 0}\n'
    + '  serializedVersion: 6\n'
    + '  m_Component:\n'
    + '  - component: {fileID: ' + transformId + '}\n';
  (extraComponents || []).forEach(function (c) { s += '  - component: {fileID: ' + c + '}\n'; });
  s += '  m_Layer: 0\n  m_Name: ' + name + '\n  m_TagString: Untagged\n  m_Icon: {fileID: 0}\n'
    + '  m_NavMeshLayer: 0\n  m_StaticEditorFlags: 0\n  m_IsActive: true\n';
  return s;
}

function transform(id, goId, pos, father, children, rootOrder) {
  let s = '--- !u!4 &' + id + '\nTransform:\n'
    + '  m_ObjectHideFlags: 0\n'
    + '  m_CorrespondingSourceObject: {fileID: 0}\n'
    + '  m_PrefabInstance: {fileID: 0}\n'
    + '  m_PrefabAsset: {fileID: 0}\n'
    + '  m_GameObject: {fileID: ' + goId + '}\n'
    + '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}\n'
    + '  m_LocalPosition: {x: ' + pos[0] + ', y: ' + pos[1] + ', z: ' + pos[2] + '}\n'
    + '  m_LocalScale: {x: 1, y: 1, z: 1}\n';
  if (children && children.length) {
    s += '  m_Children:\n';
    children.forEach(function (c) { s += '  - {fileID: ' + c + '}\n'; });
  } else {
    s += '  m_Children: []\n';
  }
  s += '  m_Father: {fileID: ' + father + '}\n'
    + '  m_RootOrder: ' + rootOrder + '\n'
    + '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}\n';
  return s;
}

function monoBehaviour(id, goId, guid, fields) {
  let s = '--- !u!114 &' + id + '\nMonoBehaviour:\n'
    + '  m_ObjectHideFlags: 0\n'
    + '  m_CorrespondingSourceObject: {fileID: 0}\n'
    + '  m_PrefabInstance: {fileID: 0}\n'
    + '  m_PrefabAsset: {fileID: 0}\n'
    + '  m_GameObject: {fileID: ' + goId + '}\n'
    + '  m_Enabled: 1\n'
    + '  m_EditorHideFlags: 0\n'
    + '  m_Script: {fileID: 11500000, guid: ' + guid + ', type: 3}\n'
    + '  m_Name: \n'
    + '  m_EditorClassIdentifier: \n';
  (fields || []).forEach(function (f) { s += '  ' + f + '\n'; });
  return s;
}

function rigidbody(id, goId) {
  return '--- !u!54 &' + id + '\nRigidbody:\n'
    + '  m_ObjectHideFlags: 0\n'
    + '  m_CorrespondingSourceObject: {fileID: 0}\n'
    + '  m_PrefabInstance: {fileID: 0}\n'
    + '  m_PrefabAsset: {fileID: 0}\n'
    + '  m_GameObject: {fileID: ' + goId + '}\n'
    + '  m_Mass: 1\n  m_Drag: 0\n  m_AngularDrag: 0.05\n  m_UseGravity: 1\n  m_IsKinematic: 0\n'
    + '  m_Interpolate: 0\n  m_Constraints: 0\n  m_CollisionDetection: 0\n  serializedVersion: 2\n';
}

function boxCollider(id, goId) {
  return '--- !u!65 &' + id + '\nBoxCollider:\n'
    + '  m_ObjectHideFlags: 0\n'
    + '  m_CorrespondingSourceObject: {fileID: 0}\n'
    + '  m_PrefabInstance: {fileID: 0}\n'
    + '  m_PrefabAsset: {fileID: 0}\n'
    + '  m_GameObject: {fileID: ' + goId + '}\n'
    + '  m_Material: {fileID: 0}\n  m_IsTrigger: 0\n  m_Enabled: 1\n  serializedVersion: 2\n'
    + '  m_Size: {x: 1, y: 1, z: 1}\n  m_Center: {x: 0, y: 0, z: 0}\n';
}

function generate(projectDir) {
  let out = '%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n';
  // Player
  out += gameObject(100000, 200000, 'Player', [300001, 300002, 400001]);
  out += transform(200000, 100000, [0, 0.5, 0], 0, [], 0);
  out += rigidbody(300001, 100000);
  out += boxCollider(300002, 100000);
  out += monoBehaviour(400001, 100000, PLAYER_GUID, ['moveSpeed: 5', 'jumpForce: 8']);
  // Floor
  out += gameObject(100001, 200001, 'Floor', [300003]);
  out += transform(200001, 100001, [0, -0.5, 0], 0, [], 1);
  out += boxCollider(300003, 100001);
  // Level + Enemies parent
  out += gameObject(100002, 200002, 'Level', []);
  out += transform(200002, 100002, [0, 0, 0], 0, [200003], 2);
  out += gameObject(100003, 200003, 'Enemies', []);
  const enemyTransforms = [];
  for (let i = 0; i < COUNT; i++) enemyTransforms.push(210000 + i);
  out += transform(200003, 100003, [0, 0, 0], 200002, enemyTransforms, 0);
  // 500 enemies, laid out in a 25x20 grid so the scene is viewable.
  for (let i = 0; i < COUNT; i++) {
    const name = 'Enemy_' + String(i).padStart(3, '0');
    const go = 110000 + i, tr = 210000 + i, mb = 410000 + i;
    const x = (i % 25) * 2 - 24, z = Math.floor(i / 25) * 2;
    out += gameObject(go, tr, name, [mb]);
    out += transform(tr, go, [x, 0.5, z], 200003, [], i);
    out += monoBehaviour(mb, go, ENEMY_GUID, ['health: 100']);
  }
  // EvalProbe
  out += gameObject(100007, 200007, 'EvalProbe', [400005]);
  out += transform(200007, 100007, [0, 0, 0], 0, [], 3);
  out += monoBehaviour(400005, 100007, PROBE_GUID, ['playerName: Player']);
  const scenePath = path.join(projectDir, 'Assets', 'Scenes', 'Main.unity');
  fs.mkdirSync(path.dirname(scenePath), { recursive: true });
  fs.writeFileSync(scenePath, out, 'utf8');
  return { ok: true, added: COUNT + ' enemies in Main.unity' };
}

module.exports = { generate, COUNT };
