import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { RacketId } from "../core/types";
import { downgradeNoopPhysicalMaterials, mergeUntexturedSubtree } from "./meshOptimize";

interface ModelCatalog {
  player: THREE.Group;
  accessories: Map<string, THREE.Object3D>;
  rackets: Record<RacketId, THREE.Group>;
  props: {
    umpire_chair: THREE.Group;
    bench_umbrella: THREE.Group;
    palm_tree: THREE.Group;
    scoreboard_led: THREE.Group;
    pier_lantern: THREE.Group;
    floodlight_tower: THREE.Group;
    sailboat: THREE.Group;
    lighthouse: THREE.Group;
    ball_basket: THREE.Group;
    lagoon_trophy: THREE.Group;
  };
  venues: {
    coral_cove_arch: THREE.Group;
    emerald_pavilion: THREE.Group;
  };
}

const MODEL_PATHS: Array<{ key: string; url: string }> = [
  { key: "player", url: "./models/characters/tennis_player.glb" },
  { key: "accessories", url: "./models/characters/accessories.glb" },
  { key: "racket_classic", url: "./models/rackets/racket_classic.glb" },
  { key: "racket_coral", url: "./models/rackets/racket_coral.glb" },
  { key: "racket_carbon", url: "./models/rackets/racket_carbon.glb" },
  { key: "racket_gold", url: "./models/rackets/racket_gold.glb" },
  { key: "racket_flame", url: "./models/rackets/racket_flame.glb" },
  { key: "umpire_chair", url: "./models/props/umpire_chair.glb" },
  { key: "bench_umbrella", url: "./models/props/bench_umbrella.glb" },
  { key: "palm_tree", url: "./models/props/palm_tree.glb" },
  { key: "scoreboard_led", url: "./models/props/scoreboard_led.glb" },
  { key: "pier_lantern", url: "./models/props/pier_lantern.glb" },
  { key: "floodlight_tower", url: "./models/props/floodlight_tower.glb" },
  { key: "sailboat", url: "./models/props/sailboat.glb" },
  { key: "lighthouse", url: "./models/props/lighthouse.glb" },
  { key: "ball_basket", url: "./models/props/ball_basket.glb" },
  { key: "lagoon_trophy", url: "./models/props/lagoon_trophy.glb" },
  { key: "coral_cove_arch", url: "./models/venues/coral_cove_arch.glb" },
  { key: "emerald_pavilion", url: "./models/venues/emerald_pavilion.glb" },
];

const STATIC_MERGE_PRESERVE: Record<string, { mats?: Set<string>; nodes?: Set<string> }> = {
  umpire_chair: {},
  bench_umbrella: { mats: new Set(["Mat_CanopyA"]) },
  palm_tree: {},
  scoreboard_led: { nodes: new Set(["LED_Screen"]) },
  pier_lantern: { mats: new Set(["Mat_LanternGlow"]) },
  floodlight_tower: { mats: new Set(["Mat_FloodGlow"]) },
  sailboat: {},
  lighthouse: { mats: new Set(["Mat_LampGlow"]) },
  ball_basket: {},
  coral_cove_arch: { mats: new Set(["Mat_VenueLampGlow"]) },
  emerald_pavilion: { mats: new Set(["Mat_VenueLampGlow"]) },
};

export function cloneWithFreshMaterials(root: THREE.Object3D): THREE.Group {
  const copy = root.clone(true) as THREE.Group;
  const matMap = new Map<THREE.Material, THREE.Material>();
  const cloneIfMutable = (mat: THREE.Material): THREE.Material => {
    if (mat.userData?.sharedVertexPbr) return mat;
    if (!matMap.has(mat)) matMap.set(mat, mat.clone());
    return matMap.get(mat)!;
  };
  copy.traverse((obj) => {
    if ((obj as THREE.Mesh).isMesh) {
      const m = obj as THREE.Mesh;
      m.castShadow = true;
      m.receiveShadow = true;
      if (Array.isArray(m.material)) {
        m.material = m.material.map(cloneIfMutable);
      } else if (m.material) {
        m.material = cloneIfMutable(m.material);
      }
    }
  });
  return copy;
}

export class AssetManager {
  public models!: ModelCatalog;

  public async loadAll(onProgress?: (pct: number, label: string) => void): Promise<void> {
    const loader = new GLTFLoader();
    let done = 0;

    const accessories = new Map<string, THREE.Object3D>();
    const loaded: Record<string, THREE.Group> = {};

    await Promise.all(
      MODEL_PATHS.map(async ({ key, url }) => {
        const gltf = await loader.loadAsync(url).catch((err) => {
          throw new Error(`Failed to load 3D asset "${key}" (${url}): ${err instanceof Error ? err.message : String(err)}`);
        });
        const root = gltf.scene;
        root.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) {
            obj.castShadow = true;
            obj.receiveShadow = true;
          }
        });

        // 1. Strip no-op clearcoat=0 MeshPhysicalMaterial shaders -> fast MeshStandardMaterial
        downgradeNoopPhysicalMaterials(root);

        // 2. Merge untextured opaque meshes per static prop/venue & racket into 1-2 PBR draw calls!
        const mergeCfg = STATIC_MERGE_PRESERVE[key];
        if (mergeCfg) {
          mergeUntexturedSubtree(root, {
            preserveMats: mergeCfg.mats,
            preserveNodes: mergeCfg.nodes,
            label: key,
          });
        } else if (key.startsWith("racket_")) {
          // Merge non-clearcoat untextured parts (bumper, grip wrap, skive, strings) while preserving glossy clearcoat frame
          mergeUntexturedSubtree(root, { label: key });
        }

        if (key === "accessories") {
          root.children.forEach((child) => {
            accessories.set(child.name, child);
          });
          // Also index nested named Hair_ / Hat_ objects if Blender grouped them under a scene node
          root.traverse((obj) => {
            if (/^(Hair_|Hat_)/.test(obj.name) && !accessories.has(obj.name)) {
              accessories.set(obj.name, obj);
            }
          });
        } else {
          loaded[key] = root;
        }

        done++;
        if (onProgress) onProgress(done / MODEL_PATHS.length, key.replace(/_/g, " "));
      })
    );

    this.models = {
      player: loaded.player,
      accessories,
      rackets: {
        classic: loaded.racket_classic,
        coral: loaded.racket_coral,
        carbon: loaded.racket_carbon,
        gold: loaded.racket_gold,
        flame: loaded.racket_flame,
      },
      props: {
        umpire_chair: loaded.umpire_chair,
        bench_umbrella: loaded.bench_umbrella,
        palm_tree: loaded.palm_tree,
        scoreboard_led: loaded.scoreboard_led,
        pier_lantern: loaded.pier_lantern,
        floodlight_tower: loaded.floodlight_tower,
        sailboat: loaded.sailboat,
        lighthouse: loaded.lighthouse,
        ball_basket: loaded.ball_basket,
        lagoon_trophy: loaded.lagoon_trophy,
      },
      venues: {
        coral_cove_arch: loaded.coral_cove_arch,
        emerald_pavilion: loaded.emerald_pavilion,
      },
    };
  }
}
