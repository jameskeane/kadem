import * as crypto from 'crypto';



/**
 * The 'promise selector' allows us to simulate a more traditional networking
 * api. i.e. loop and 'block' until any outstanding request resolves.
 * @template T
 */
export class PromiseSelector {
  /**
   * @typedef {Promise<[Error|undefined, T|undefined, ()=>void]>} WrappingPromise
   */

  /**
   * @param {Array<Promise<T>>=} opt_init Optionally initialize the selector.
   */
  constructor(opt_init) {
    /** @type {Array<WrappingPromise>} */
    this.promises = [];

    if (opt_init) this.add(opt_init);
  }

  /**
   * The number of unresolved promises in the select queue.
   * @return {number}
   */
  get length() { return this.promises.length; }

  /**
   * Add promises to the selector.
   * @param {Array.<Promise<T>>|Promise<T>} promises
   */
  add(promises) {
    if (!Array.isArray(promises)) promises = [promises];
    
    promises
        // .filter((p) => this.promises.indexOf(p) === -1)
        .forEach((p) => {
          /** @type {WrappingPromise} */
          let pr;
          const remove = () => this.promises.splice(this.promises.indexOf(pr), 1);
          pr = p.then(
            (res) => [undefined, res, remove],
            (err) => [err, undefined, remove]);
          this.promises.push(pr);
        });
  }

  /**
   * Get the next promise that resolves or rejects.
   * @return {Promise<T>|null}
   */
  next() {
    if (this.promises.length === 0) return null;
    return Promise.race(this.promises)
        .then(([err, res, remove]) => {
          remove();
          if (err) throw err;
          if (res === undefined) throw new Error("Result is undefined");
          return res;
        });
  }
}


/**
 * Simple sha1 hash.
 * @param {Buffer} data The data to hash.
 * @return {Buffer} The sha1 hash.
 */
export function sha1(data) {
  return crypto.createHash('sha1').update(data).digest();
};



/**
 * A simple fixed length priority queue, used for DHT navigation.
 * @template T
 */
export class PQueue {
  /**
   * @param {number} fixedLen The maximum number of items in the queue.
   */
  constructor(fixedLen) {
    /** @type {Array.<[number, T|null]>} */
    this.arr_ = [];
    this.flen_ = fixedLen;
    for (let i = 0; i < fixedLen; i++) this.arr_.push([Infinity, null]);
  }

  /**
   * Push an item into the queue.
   * @param {number} n The 'priority' of the item.
   * @param {T} v The item.
   */
  push(n, v) {
    for (let i = 0; i < this.flen_; i++) {
      if (n < this.arr_[i][0]) {
        this.arr_.splice(i, 0, [n, v]);  // splice in
        this.arr_.pop();                 // pop the furthest
        break;
      }
    }
  }

  get max() {
    return this.arr_[this.flen_ - 1][0]
  }

  items() {
    return this.arr_
        .filter(([n, v]) => v !== null)
        .map(([n, v]) => v);
  }
}
