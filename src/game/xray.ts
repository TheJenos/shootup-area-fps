import * as THREE from 'three';

/*
 * Teammates hidden behind cover are drawn over the walls as a flat 2D silhouette of their
 * actual character, in their team colour: the same body, pose and animation, just unlit.
 *
 * It's only shown once the teammate is hidden (chest and head both behind cover), and then the
 * whole body is drawn on top of everything (no depth test), so it reads as one clean shape
 * instead of the parts that happen to poke out. Nearly flat: a touch of shading keeps arms
 * in front of the body readable. It ignores fog so teammates stay visible across the map.
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
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float facing = abs(dot(normalize(vNormal), normalize(vView)));
    gl_FragColor = vec4(color * (0.78 + 0.22 * facing), 1.0);
    #include <colorspace_fragment>
  }
`;

export function makeXrayMaterial(color: THREE.ColorRepresentation): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      color: { value: new THREE.Color(color) },
    },
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
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
    // After the world so the depth buffer already holds the walls.
    copy.renderOrder = 10;
    copy.visible = false;
    mesh.parent?.add(copy);
    return copy;
  });
}
