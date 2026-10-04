import * as THREE from 'three';

/*
 * Teammates hidden behind cover are drawn as a glowing outline in their team colour.
 *
 * The x-ray copy of the body uses an inverted depth test (GreaterDepth): it only draws where
 * something else is already closer to the camera, i.e. exactly the parts hidden behind walls.
 * The shader is a rim light: bright at the silhouette's edges and faint in the middle, which
 * reads as an outline. It ignores fog so teammates stay visible across the map.
 */

const vertexShader = /* glsl */ `
  #include <common>
  #include <skinning_pars_vertex>
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <defaultnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    #include <project_vertex>
    vNormal = normalize(transformedNormal);
    vView = normalize(-mvPosition.xyz);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vView)));
    float rim = pow(1.0 - facing, 2.2);
    gl_FragColor = vec4(color, opacity * (0.12 + rim * 0.88));
  }
`;

export function makeXrayMaterial(color: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(color) },
      opacity: { value: 0.9 },
    },
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
}

/**
 * An x-ray copy of each skinned mesh in `model`, sharing its geometry and skeleton so it moves
 * with the animation. Added next to the originals; hidden until `visible` is turned on.
 */
export function makeXrayMeshes(model: THREE.Object3D, material: THREE.ShaderMaterial): THREE.SkinnedMesh[] {
  const sources: THREE.SkinnedMesh[] = [];
  model.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) sources.push(o as THREE.SkinnedMesh);
  });
  return sources.map((mesh) => {
    const copy = new THREE.SkinnedMesh(mesh.geometry, material);
    copy.bind(mesh.skeleton, mesh.bindMatrix);
    copy.position.copy(mesh.position);
    copy.quaternion.copy(mesh.quaternion);
    copy.scale.copy(mesh.scale);
    copy.frustumCulled = false;
    // After the world (and other transparent things) so the depth buffer already holds the walls.
    copy.renderOrder = 10;
    copy.visible = false;
    mesh.parent?.add(copy);
    return copy;
  });
}
