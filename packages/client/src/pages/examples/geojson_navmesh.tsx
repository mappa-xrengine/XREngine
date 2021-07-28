import { Timer } from '@xrengine/engine/src/common/functions/Timer'
import { Engine } from '@xrengine/engine/src/ecs/classes/Engine'
import { System } from '@xrengine/engine/src/ecs/classes/System'
import { execute } from '@xrengine/engine/src/ecs/functions/EngineFunctions'
import { registerSystem } from '@xrengine/engine/src/ecs/functions/SystemFunctions'
import { SystemUpdateType } from '@xrengine/engine/src/ecs/functions/SystemUpdateType'
import { OrbitControls } from '@xrengine/engine/src/input/functions/OrbitControls'
import { createCellSpaceHelper } from '@xrengine/engine/src/navigation/CellSpacePartitioningHelper'
import { CustomVehicle } from '@xrengine/engine/src/navigation/CustomVehicle'
import { createConvexRegionHelper } from '@xrengine/engine/src/navigation/NavMeshHelper'
import { PathPlanner } from '@xrengine/engine/src/navigation/PathPlanner'
import React, { useEffect } from 'react'
import {
  AmbientLight,
  BufferGeometry,
  ConeBufferGeometry,
  DirectionalLight,
  GridHelper,
  HemisphereLight,
  InstancedMesh,
  Line,
  LineBasicMaterial,
  LoadingManager,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer
} from 'three'
import { CellSpacePartitioning, EntityManager, FollowPathBehavior, NavMeshLoader, Time } from 'yuka'
import { GLTFLoader } from '@xrengine/engine/src/assets/loaders/gltf/GLTFLoader'
import { Component } from '@xrengine/engine/src/ecs/classes/Component'
import {
  addComponent,
  createEntity,
  getComponent,
  getMutableComponent
} from '@xrengine/engine/src/ecs/functions/EntityFunctions'
import { registerComponent } from '@xrengine/engine/src/ecs/functions/ComponentFunctions'
import { initializeEngine } from '@xrengine/engine/src/initializeEngine'
import { EngineSystemPresets } from '@xrengine/engine/src/initializationOptions'
import { NavMeshBuilder } from '../../../../engine/src/map/NavMeshBuilder'
import { computeBoundingBox, subtract } from '../../../../engine/src/map/GeoJSONFns'
import { fetchFeatures, llToScene } from '../../../../engine/src/map/MeshBuilder'
import { Position, Polygon, MultiPolygon } from 'geojson'

class RenderSystem extends System {
  updateType = SystemUpdateType.Fixed
  /**
   * Execute the camera system for different events of queries.\
   * Called each frame by default.
   *
   * @param delta time since last frame.
   */
  execute(delta: number): void {
    Engine.renderer.render(Engine.scene, Engine.camera)
  }
}

const pathMaterial = new LineBasicMaterial({ color: 0xff0000 })
const vehicleMaterial = new MeshBasicMaterial({ color: 0xff0000 })
const vehicleGeometry = new ConeBufferGeometry(0.1, 0.5, 16)
vehicleGeometry.rotateX(Math.PI * 0.5)
vehicleGeometry.translate(0, 0.1, 0)
const vehicleCount = 1

const vehicleMesh = new InstancedMesh(vehicleGeometry, vehicleMaterial, vehicleCount)
// setup spatial index

const width = 100,
  height = 40,
  depth = 75
const cellsX = 20,
  cellsY = 5,
  cellsZ = 20

class NavigationComponent extends Component<NavigationComponent> {
  pathPlanner: PathPlanner = new PathPlanner()
  entityManager: EntityManager = new EntityManager()
  time: Time = new Time()
  vehicles = []
  pathHelpers = []
  spatialIndexHelper
  regionHelper
  navigationMesh
}

const meshUrl = '/models/navmesh/navmesh.glb'

function scaleAndTranslatePosition(position: Position, llCenter: Position) {
  return [(position[0] - llCenter[0]) * 1000, (position[1] - llCenter[1]) * 1000]
}

function scaleAndTranslatePolygon(coords: Position[][], llCenter: Position) {
  return [coords[0].map((position) => scaleAndTranslatePosition(position, llCenter))]
}
function scaleAndTranslate(geometry: Polygon | MultiPolygon, llCenter: [number, number]) {
  switch (geometry.type) {
    case 'MultiPolygon':
      geometry.coordinates = geometry.coordinates.map((coords) => scaleAndTranslatePolygon(coords, llCenter))
      break
    case 'Polygon':
      geometry.coordinates = scaleAndTranslatePolygon(geometry.coordinates, llCenter)
      break
  }

  return geometry
}

const loadNavMeshFromMapBox = async (navigationComponent) => {
  const builder = new NavMeshBuilder()
  const center = [-84.388, 33.79]
  const mapFeatures = await fetchFeatures(center)
  const mapGeoms = mapFeatures
    // There's some issue with Polygons at the moment
    // .filter((feature) => ['Polygon', 'MultiPolygon'].indexOf(feature.geometry.type) >= 0)
    .filter((feature) => feature.geometry.type === 'MultiPolygon')
    .map((feature) => scaleAndTranslate(feature.geometry as Polygon | MultiPolygon, center as any))
    .slice(0, 10) as (Polygon | MultiPolygon)[]

  const groundGeom = computeBoundingBox(mapGeoms)
  subtract(groundGeom, mapGeoms)
  builder.addGeometry(groundGeom)
  const navigationMesh = builder.build()
  loadNavMesh(navigationMesh, navigationComponent)
}

const loadNavMesh = async (navigationMesh, navigationComponent) => {
  //       // visualize convex regions

  navigationComponent.regionHelper = createConvexRegionHelper(navigationMesh)
  navigationComponent.regionHelper.visible = true
  Engine.scene.add(navigationComponent.regionHelper)

  navigationComponent.pathPlanner = new PathPlanner(navigationMesh)

  navigationMesh.spatialIndex = new CellSpacePartitioning(width, height, depth, cellsX, cellsY, cellsZ)
  navigationMesh.updateSpatialIndex()
  navigationComponent.navigationMesh = navigationMesh

  // navigationComponent.spatialIndexHelper = createCellSpaceHelper(navigationMesh.spatialIndex)
  // Engine.scene.add(navigationComponent.spatialIndexHelper)
  // navigationComponent.spatialIndexHelper.visible = false
}

async function startDemo(entity) {
  const navigationComponent = getMutableComponent(entity, NavigationComponent)
  await loadNavMeshFromMapBox(navigationComponent)

  vehicleMesh.frustumCulled = false
  Engine.scene.add(vehicleMesh)

  for (let i = 0; i < vehicleCount; i++) {
    // path helper

    const pathHelper = new Line(new BufferGeometry(), pathMaterial)
    // pathHelper.visible = false
    Engine.scene.add(pathHelper)
    navigationComponent.pathHelpers.push(pathHelper)

    // vehicle

    const vehicle = new CustomVehicle()
    vehicle.navMesh = navigationComponent.navigationMesh
    vehicle.maxSpeed = 1.5
    vehicle.maxForce = 10

    const toRegion = vehicle.navMesh.getRandomRegion()
    vehicle.position.copy(toRegion.centroid)
    vehicle.toRegion = toRegion

    const followPathBehavior = new FollowPathBehavior()
    followPathBehavior.nextWaypointDistance = 0.5
    followPathBehavior.active = false
    vehicle.steering.add(followPathBehavior)

    navigationComponent.entityManager.add(vehicle)
    navigationComponent.vehicles.push(vehicle)
  }
}

class NavigationSystem extends System {
  updateType = SystemUpdateType.Fixed

  constructor() {
    super()
    registerComponent(NavigationComponent)
    const entity = createEntity()
    addComponent(entity, NavigationComponent)
    startDemo(entity)
  }

  /**
   * Execute the camera system for different events of queries.\
   * Called each frame by default.
   *
   * @param delta time since last frame.
   */
  execute(delta: number): void {
    for (const entity of this.queryResults.navigation.all) {
      const navComponent = getComponent(entity, NavigationComponent)

      navComponent.entityManager.update(delta)

      navComponent.pathPlanner.update()

      // Update pathfinding

      for (let i = 0, l = navComponent.vehicles.length; i < l; i++) {
        const vehicle = navComponent.vehicles[i]

        if (vehicle.currentRegion === vehicle.toRegion) {
          vehicle.fromRegion = vehicle.toRegion
          vehicle.toRegion = vehicle.navMesh.getRandomRegion()

          const from = vehicle.position
          const to = vehicle.toRegion.centroid

          navComponent.pathPlanner.findPath(vehicle, from, to, (vehicle, path) => {
            // update path helper

            const index = navComponent.vehicles.indexOf(vehicle)
            const pathHelper = navComponent.pathHelpers[index]

            pathHelper.geometry.dispose()
            pathHelper.geometry = new BufferGeometry().setFromPoints(path)

            // update path and steering

            const followPathBehavior = vehicle.steering.behaviors[0]
            followPathBehavior.active = true
            followPathBehavior.path.clear()

            for (const point of path) {
              followPathBehavior.path.add(point)
            }
          })
        }
      }

      // Update instancing
      for (let i = 0, l = navComponent.vehicles.length; i < l; i++) {
        const vehicle = navComponent.vehicles[i]
        vehicleMesh.setMatrixAt(i, vehicle.worldMatrix)
      }

      vehicleMesh.instanceMatrix.needsUpdate = true
    }
  }
}

NavigationSystem.queries = {
  navigation: {
    components: [NavigationComponent],
    listen: {
      removed: true,
      added: true
    }
  }
}

// This is a functional React component
const Page = () => {
  useEffect(() => {
    ;(async function () {
      initializeEngine({
        type: EngineSystemPresets.EXAMPLE
      })

      // Register our systems to do stuff
      Engine.engineTimer = Timer(
        {
          networkUpdate: (delta: number, elapsedTime: number) => execute(delta, elapsedTime, SystemUpdateType.Network),
          fixedUpdate: (delta: number, elapsedTime: number) => execute(delta, elapsedTime, SystemUpdateType.Fixed),
          update: (delta, elapsedTime) => execute(delta, elapsedTime, SystemUpdateType.Free)
        },
        Engine.physicsFrameRate,
        Engine.networkFramerate
      )
      // Set up rendering and basic scene for demo
      const canvas = document.createElement('canvas')
      document.body.appendChild(canvas) // adds the canvas to the body element

      let w = window.innerWidth,
        h = window.innerHeight

      let ctx = canvas.getContext('webgl2') //, { alpha: false }
      Engine.renderer = new WebGLRenderer({ canvas: canvas, context: ctx, antialias: true })

      Engine.renderer.setClearColor(0x3a3a3a, 1)
      Engine.renderer.setSize(w, h)

      Engine.scene = new Scene()
      Engine.scene.add(new GridHelper(20, 20, 0x0c610c, 0x444444))

      Engine.camera = new PerspectiveCamera(45, w / h, 0.01, 1000)
      Engine.camera.position.set(2, 40, 5)
      Engine.camera.rotation.set(0, 0.3, 0)

      const controls = new OrbitControls(Engine.camera, canvas)
      controls.minDistance = 0.1
      controls.maxDistance = 10
      controls.target.set(0, 1.25, 0)
      controls.update()

      Engine.scene.add(Engine.camera)

      let light = new DirectionalLight(0xffffff, 1.0)
      light.position.set(4, 10, 1)
      Engine.scene.add(light)

      Engine.scene.add(new AmbientLight(0x404040))

      registerSystem(NavigationSystem)
      registerSystem(RenderSystem)
      await Promise.all(Engine.systems.map((system) => system.initialize()))

      Engine.engineTimer.start()

      window.addEventListener('resize', onWindowResize)

      function onWindowResize() {
        Engine.camera.aspect = window.innerWidth / window.innerHeight
        Engine.camera.updateProjectionMatrix()

        Engine.renderer.setSize(window.innerWidth, window.innerHeight)
      }
    })()
  }, [])
  // Some JSX to keep the compiler from complaining
  return <section id="loading-screen"></section>
}

export default Page
