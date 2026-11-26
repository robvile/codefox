// gen-scene.js — nullref overlay (v0.18.0 eval fixture).
//
// Appends a "NullRef" scene object (Transform + NullRef component)
// to the base Main.unity, so the seeded NullReferenceException
// fires when the game enters Play Mode. Plain Node, required by
// the main process during fixture setup; generate(projectDir)
// receives the project dir whose Assets/Scenes/Main.unity is the
// base scene copy. FileIDs are allocated above the highest id
// already in the scene, so the overlay never collides with it.
'use strict';
const fs = require('fs');
const path = require('path');

function generate(projectDir) {
  const scenePath = path.join(projectDir, 'Assets', 'Scenes', 'Main.unity');
  let scene = fs.readFileSync(scenePath, 'utf8');
  let maxId = 0;
  const re = /^--- !u!\d+ &(\d+)/gm;
  let m;
  while ((m = re.exec(scene)) !== null) maxId = Math.max(maxId, parseInt(m[1], 10));
  const go = maxId + 1, tr = maxId + 2, mb = maxId + 3;
  if (!scene.endsWith('\n')) scene += '\n';
  scene += '--- !u!1 &' + go + '\n'
    + 'GameObject:\n'
    + '  m_ObjectHideFlags: 0\n'
    + '  m_CorrespondingSourceObject: {fileID: 0}\n'
    + '  m_PrefabInstance: {fileID: 0}\n'
    + '  m_PrefabAsset: {fileID: 0}\n'
    + '  serializedVersion: 6\n'
    + '  m_Component:\n'
    + '  - component: {fileID: ' + tr + '}\n'
    + '  - component: {fileID: ' + mb + '}\n'
    + '  m_Layer: 0\n'
    + '  m_Name: NullRef\n'
    + '  m_TagString: Untagged\n'
    + '  m_Icon: {fileID: 0}\n'
    + '  m_NavMeshLayer: 0\n'
    + '  m_StaticEditorFlags: 0\n'
    + '  m_IsActive: true\n'
    + '--- !u!4 &' + tr + '\n'
    + 'Transform:\n'
    + '  m_ObjectHideFlags: 0\n'
    + '  m_CorrespondingSourceObject: {fileID: 0}\n'
    + '  m_PrefabInstance: {fileID: 0}\n'
    + '  m_PrefabAsset: {fileID: 0}\n'
    + '  m_GameObject: {fileID: ' + go + '}\n'
    + '  m_LocalRotation: {x: 0, y: 0, z: 0, w: 1}\n'
    + '  m_LocalPosition: {x: 0, y: 0, z: 0}\n'
    + '  m_LocalScale: {x: 1, y: 1, z: 1}\n'
    + '  m_Children: []\n'
    + '  m_Father: {fileID: 0}\n'
    + '  m_RootOrder: 4\n'
    + '  m_LocalEulerAnglesHint: {x: 0, y: 0, z: 0}\n'
    + '--- !u!114 &' + mb + '\n'
    + 'MonoBehaviour:\n'
    + '  m_ObjectHideFlags: 0\n'
    + '  m_CorrespondingSourceObject: {fileID: 0}\n'
    + '  m_PrefabInstance: {fileID: 0}\n'
    + '  m_PrefabAsset: {fileID: 0}\n'
    + '  m_GameObject: {fileID: ' + go + '}\n'
    + '  m_Enabled: 1\n'
    + '  m_EditorHideFlags: 0\n'
    + '  m_Script: {fileID: 11500000, guid: 3124fdacfbcc0ed8555c62f27df6c98c, type: 3}\n'
    + '  m_Name: \n'
    + '  m_EditorClassIdentifier: \n';
  fs.writeFileSync(scenePath, scene, 'utf8');
  return { ok: true, added: 'NullRef object (fileIDs ' + go + '/' + tr + '/' + mb + ')' };
}

module.exports = { generate };
