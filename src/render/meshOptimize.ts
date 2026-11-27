import * as THREE from "three";

const sharedVertexPbrMats: Record<"fs" | "ds", THREE.MeshStandardMaterial | null> = {
  fs: null,
  ds: null,
};

/**
 * Shared MeshStandardMaterial that reads per-vertex roughness (aPbr.x) and
 * metalness (aPbr.y) alongside linear vertex colors, preserving 100% exact PBR
 * material response across merged untextured meshes in a single draw call.
 */
function getVertexPbrMaterial(doubleSided: boolean): THREE.MeshStandardMaterial {
  const key = doubleSided ? "ds" : "fs";
  let mat = sharedVertexPbrMats[key];
  if (mat) return mat;

  mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1.0,
    metalness: 1.0,
    side: doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  mat.name = doubleSided ? "Shared_VertexPBR_DS" : "Shared_VertexPBR_FS";
  mat.userData.sharedVertexPbr = true;
  mat.customProgramCacheKey = () => (doubleSided ? "vertex_pbr_ds_v1" : "vertex_pbr_fs_v1");
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <color_pars_vertex>",
        "#include <color_pars_vertex>\nattribute vec2 aPbr;\nvarying vec2 vPbr;"
      )
      .replace("#include <color_vertex>", "#include <color_vertex>\nvPbr = aPbr;");

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <color_pars_fragment>", "#include <color_pars_fragment>\nvarying vec2 vPbr;")
      .replace("#include <roughnessmap_fragment>", "float roughnessFactor = vPbr.x;")
      .replace("#include <metalnessmap_fragment>", "float metalnessFactor = vPbr.y;");
  };

  sharedVertexPbrMats[key] = mat;
  return mat;
}

/**
 * Blender 5.3's glTF exporter often emits KHR_materials_clearcoat with
 * clearcoatFactor = 0 (only clearcoatRoughnessFactor set), causing Three.js to
 * compile full dual-lobe MeshPhysicalMaterial shaders for plain matte props.
 * Convert no-op Physical materials back to fast MeshStandardMaterial with
 * pixel-identical shading.
 */
export function downgradeNoopPhysicalMaterials(root: THREE.Object3D): void {
  const map = new Map<THREE.Material, THREE.Material>();

  const convert = (mat: THREE.Material): THREE.Material => {
    if (map.has(mat)) return map.get(mat)!;
    const p = mat as THREE.MeshPhysicalMaterial;
    if (!p.isMeshPhysicalMaterial) return mat;

    const hasPhysicalFeatures =
      (p.clearcoat || 0) > 0.001 ||
      !!p.clearcoatMap ||
      (p.transmission || 0) > 0.001 ||
      !!p.transmissionMap ||
      (p.sheen || 0) > 0.001 ||
      !!p.sheenColorMap ||
      (p.iridescence || 0) > 0.001 ||
      (p.anisotropy || 0) > 0.001 ||
      (p.dispersion || 0) > 0.001 ||
      (p.thickness || 0) > 0.001;

    if (hasPhysicalFeatures) {
      map.set(mat, mat);
      return mat;
    }

    const std = new THREE.MeshStandardMaterial({
      name: p.name,
      color: p.color.clone(),
      roughness: p.roughness,
      metalness: p.metalness,
      map: p.map,
      normalMap: p.normalMap,
      normalScale: p.normalScale.clone(),
      roughnessMap: p.roughnessMap,
      metalnessMap: p.metalnessMap,
      aoMap: p.aoMap,
      aoMapIntensity: p.aoMapIntensity,
      emissive: p.emissive.clone(),
      emissiveMap: p.emissiveMap,
      emissiveIntensity: p.emissiveIntensity,
      side: p.side,
      transparent: p.transparent,
      opacity: p.opacity,
      alphaTest: p.alphaTest,
      depthWrite: p.depthWrite,
      vertexColors: p.vertexColors,
      flatShading: p.flatShading,
      envMapIntensity: p.envMapIntensity,
    });
    map.set(mat, std);
    p.dispose();
    return std;
  };

  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const m = obj as THREE.Mesh;
    if (Array.isArray(m.material)) {
      m.material = m.material.map(convert);
    } else if (m.material) {
      m.material = convert(m.material);
    }
  });
}

interface MergeBucket {
  pos: number[];
  norm: number[];
  col: number[];
  pbr: number[];
  idx: number[];
  vertCount: number;
  castShadow: boolean;
  receiveShadow: boolean;
}

function makeBucket(): MergeBucket {
  return { pos: [], norm: [], col: [], pbr: [], idx: [], vertCount: 0, castShadow: false, receiveShadow: false };
}

export function baseMatName(mat: THREE.Material): string {
  return (mat.name || "").replace(/\.\d+$/, "");
}

export function forEachMaterial(root: THREE.Object3D, fn: (mat: THREE.Material) => void): void {
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const raw = (obj as THREE.Mesh).material;
    if (Array.isArray(raw)) {
      for (const m of raw) {
        if (m) fn(m);
      }
    } else if (raw) {
      fn(raw);
    }
  });
}

function isMergeableStdMaterial(mat: THREE.Material, preserveMats?: Set<string>): mat is THREE.MeshStandardMaterial {
  const m = mat as THREE.MeshStandardMaterial & THREE.MeshPhysicalMaterial;
  if (!m || !m.isMeshStandardMaterial || m.isMeshPhysicalMaterial) return false;
  if (preserveMats && preserveMats.has(baseMatName(m))) return false;
  if (m.map || m.normalMap || m.roughnessMap || m.metalnessMap || m.aoMap || m.emissiveMap || m.alphaMap) return false;
  if (m.transparent || m.alphaTest > 0 || m.opacity < 0.999) return false;
  if (m.emissiveIntensity > 0 && (m.emissive.r > 0.001 || m.emissive.g > 0.001 || m.emissive.b > 0.001)) return false;
  return true;
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _nMat = new THREE.Matrix3();

function appendGeometryRange(
  bucket: MergeBucket,
  geo: THREE.BufferGeometry,
  mat: THREE.MeshStandardMaterial,
  relMatrix: THREE.Matrix4,
  start: number,
  count: number,
  castShadow: boolean,
  receiveShadow: boolean
): void {
  const posAttr = geo.attributes.position as THREE.BufferAttribute | undefined;
  if (!posAttr) return;
  const normAttr = geo.attributes.normal as THREE.BufferAttribute | undefined;
  const colAttr = geo.attributes.color as THREE.BufferAttribute | undefined;
  const index = geo.index;

  const totalIndices = index ? index.count : posAttr.count;
  const end = Math.min(totalIndices, start + count);
  if (end <= start) return;

  const flipWinding = relMatrix.determinant() < 0;
  _nMat.getNormalMatrix(relMatrix);

  const cr = mat.color.r;
  const cg = mat.color.g;
  const cb = mat.color.b;
  const rough = mat.roughness;
  const metal = mat.metalness;

  if (castShadow) bucket.castShadow = true;
  if (receiveShadow) bucket.receiveShadow = true;

  // Map source vertex index -> merged vertex index for this sub-range so vertices stay compact & indexed
  const remap = new Map<number, number>();
  const getOrAddVert = (srcIdx: number): number => {
    const existing = remap.get(srcIdx);
    if (existing !== undefined) return existing;

    _v.fromBufferAttribute(posAttr, srcIdx).applyMatrix4(relMatrix);
    bucket.pos.push(_v.x, _v.y, _v.z);

    if (normAttr) {
      _n.fromBufferAttribute(normAttr, srcIdx).applyMatrix3(_nMat).normalize();
      bucket.norm.push(_n.x, _n.y, _n.z);
    } else {
      bucket.norm.push(0, 1, 0);
    }

    if (colAttr) {
      bucket.col.push(colAttr.getX(srcIdx) * cr, colAttr.getY(srcIdx) * cg, colAttr.getZ(srcIdx) * cb);
    } else {
      bucket.col.push(cr, cg, cb);
    }

    bucket.pbr.push(rough, metal);
    const dst = bucket.vertCount++;
    remap.set(srcIdx, dst);
    return dst;
  };

  for (let i = start; i + 2 < end; i += 3) {
    const i0 = index ? index.getX(i) : i;
    const i1 = index ? index.getX(i + 1) : i + 1;
    const i2 = index ? index.getX(i + 2) : i + 2;
    const a = getOrAddVert(i0);
    const b = getOrAddVert(i1);
    const c = getOrAddVert(i2);
    if (flipWinding) {
      bucket.idx.push(a, c, b);
    } else {
      bucket.idx.push(a, b, c);
    }
  }
}

function finalizeBucket(bucket: MergeBucket, doubleSided: boolean, name: string): THREE.Mesh | null {
  if (bucket.idx.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(bucket.pos, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(bucket.norm, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(bucket.col, 3));
  geo.setAttribute("aPbr", new THREE.Float32BufferAttribute(bucket.pbr, 2));
  geo.setIndex(bucket.idx);
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, getVertexPbrMaterial(doubleSided));
  mesh.name = name;
  mesh.castShadow = bucket.castShadow;
  mesh.receiveShadow = bucket.receiveShadow;
  return mesh;
}

/**
 * Merges all mergeable untextured opaque MeshStandardMaterial primitives inside
 * `root` into at most 2 draw calls (FrontSide + DoubleSide) using per-vertex
 * linear color + per-vertex roughness/metalness, while leaving textured,
 * clearcoat, emissive, or preserved nodes/materials completely untouched.
 *
 * Optionally accepts `stopAtNodes` so character bone merging stops at child
 * bones and dynamic attachments (e.g. BackNumberAnchor, RacketSocket).
 */
export function mergeUntexturedSubtree(
  root: THREE.Object3D,
  opts?: {
    preserveMats?: Set<string>;
    preserveNodes?: Set<string>;
    stopAtNodes?: Set<THREE.Object3D>;
    label?: string;
  }
): void {
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const rel = new THREE.Matrix4();

  const fs = makeBucket();
  const ds = makeBucket();
  const toRemove: THREE.Object3D[] = [];
  let mergedPrimCount = 0;

  const visit = (node: THREE.Object3D): void => {
    if (node !== root && opts?.stopAtNodes?.has(node)) return;
    if (opts?.preserveNodes?.has(node.name)) return;

    if ((node as THREE.Mesh).isMesh) {
      const mesh = node as THREE.Mesh;
      const geo = mesh.geometry as THREE.BufferGeometry;
      if (geo && geo.attributes.position) {
        rel.multiplyMatrices(rootInv, mesh.matrixWorld);
        const total = geo.index ? geo.index.count : geo.attributes.position.count;

        if (Array.isArray(mesh.material)) {
          const groups = geo.groups;
          const remainingGroups: Array<{ start: number; count: number; materialIndex: number }> = [];
          const remainingMats: THREE.Material[] = [];
          const matIndexMap = new Map<number, number>();
          let mergedAny = false;

          for (const grp of groups) {
            const mi = grp.materialIndex ?? 0;
            const mat = mesh.material[mi];
            if (isMergeableStdMaterial(mat, opts?.preserveMats)) {
              const b = mat.side === THREE.DoubleSide ? ds : fs;
              appendGeometryRange(b, geo, mat, rel, grp.start, grp.count, mesh.castShadow, mesh.receiveShadow);
              mergedAny = true;
              mergedPrimCount++;
            } else {
              let newMi = matIndexMap.get(mi);
              if (newMi === undefined) {
                newMi = remainingMats.length;
                matIndexMap.set(mi, newMi);
                remainingMats.push(mat);
              }
              remainingGroups.push({ start: grp.start, count: grp.count, materialIndex: newMi });
            }
          }

          if (mergedAny) {
            if (remainingGroups.length === 0) {
              toRemove.push(mesh);
            } else {
              const clonedGeo = geo.clone();
              clonedGeo.clearGroups();
              for (const g of remainingGroups) clonedGeo.addGroup(g.start, g.count, g.materialIndex);
              mesh.geometry = clonedGeo;
              mesh.material = remainingMats.length === 1 ? remainingMats[0] : remainingMats;
            }
          }
        } else if (mesh.material && isMergeableStdMaterial(mesh.material, opts?.preserveMats)) {
          const b = mesh.material.side === THREE.DoubleSide ? ds : fs;
          appendGeometryRange(b, geo, mesh.material, rel, 0, total, mesh.castShadow, mesh.receiveShadow);
          mergedPrimCount++;
          toRemove.push(mesh);
        }
      }
    }

    // Recurse over a snapshot since children may be pruned afterward
    for (let i = 0; i < node.children.length; i++) {
      visit(node.children[i]);
    }
  };

  visit(root);

  if (mergedPrimCount === 0) return;

  for (const obj of toRemove) {
    if (obj.children.length === 0 && obj.parent) {
      obj.parent.remove(obj);
    } else {
      // Node has surviving children; replace with an empty transform node
      const holder = new THREE.Group();
      holder.name = obj.name;
      holder.position.copy(obj.position);
      holder.quaternion.copy(obj.quaternion);
      holder.scale.copy(obj.scale);
      while (obj.children.length > 0) holder.add(obj.children[0]);
      if (obj.parent) {
        obj.parent.add(holder);
        obj.parent.remove(obj);
      }
    }
  }

  // Prune now-empty leaf helper groups inside static props
  if (!opts?.stopAtNodes) {
    const prune = (node: THREE.Object3D): void => {
      for (let i = node.children.length - 1; i >= 0; i--) {
        const ch = node.children[i];
        prune(ch);
        if (
          !(ch as THREE.Mesh).isMesh &&
          ch.children.length === 0 &&
          !opts?.preserveNodes?.has(ch.name)
        ) {
          node.remove(ch);
        }
      }
    };
    prune(root);
  }

  const tag = opts?.label || root.name || "Static";
  const mFS = finalizeBucket(fs, false, `${tag}_MergedFS`);
  const mDS = finalizeBucket(ds, true, `${tag}_MergedDS`);
  if (mFS) root.add(mFS);
  if (mDS) root.add(mDS);
}

/**
 * Turns a static optimized template group (typically 1-3 meshes) into an array
 * of InstancedMeshes placed at every transform — turning N copies of a prop
 * into just 1-3 draw calls total!
 */
export function createInstancedPropMeshes(
  template: THREE.Object3D,
  instances: Array<{
    x: number;
    y: number;
    z: number;
    rx?: number;
    ry?: number;
    rz?: number;
    scale?: number;
  }>,
  opts?: { castShadow?: boolean; receiveShadow?: boolean; dynamic?: boolean }
): THREE.InstancedMesh[] {
  template.updateMatrixWorld(true);
  const invRoot = template.matrixWorld.clone().invert();
  const rel = new THREE.Matrix4();
  const dummy = new THREE.Object3D();
  dummy.rotation.order = "YXZ";
  const finalMat = new THREE.Matrix4();

  const out: THREE.InstancedMesh[] = [];
  template.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    rel.multiplyMatrices(invRoot, mesh.matrixWorld);
    const mat = Array.isArray(mesh.material)
      ? mesh.material.map((m) => (m.userData?.sharedVertexPbr ? m : m.clone()))
      : mesh.material.userData?.sharedVertexPbr
      ? mesh.material
      : mesh.material.clone();

    const im = new THREE.InstancedMesh(mesh.geometry, mat, instances.length);
    im.name = `${mesh.name}_Instanced`;
    im.castShadow = opts?.castShadow ?? mesh.castShadow;
    im.receiveShadow = opts?.receiveShadow ?? mesh.receiveShadow;
    if (opts?.dynamic) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
    }

    for (let i = 0; i < instances.length; i++) {
      const tr = instances[i];
      dummy.position.set(tr.x, tr.y, tr.z);
      dummy.rotation.set(tr.rx || 0, tr.ry || 0, tr.rz || 0);
      dummy.scale.setScalar(tr.scale ?? 1);
      dummy.updateMatrix();
      finalMat.multiplyMatrices(dummy.matrix, rel);
      im.setMatrixAt(i, finalMat);
    }
    im.instanceMatrix.needsUpdate = true;
    im.userData.localRelMatrix = rel.clone();
    out.push(im);
  });

  return out;
}

/**
 * Disables per-frame matrix recomputation for static scene subtrees.
 */
export function freezeStaticMatrices(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    obj.matrixAutoUpdate = false;
  });
}
