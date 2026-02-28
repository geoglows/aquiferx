declare module 'kd-tree-javascript' {
  export class kdTree<T> {
    constructor(points: T[], distFn: (a: T, b: T) => number, dims: string[]);
    nearest(point: T, count: number): [T, number][];
  }
}
