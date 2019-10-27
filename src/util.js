const crypto = require('crypto');



class PromiseSelector {
  constructor() {
    /** @type {Array<Promise>} */
    this.promises = [];
  }

  get length() { return this.promises.length; }

  /**
   * Add promises to the selector.
   * @param {Array.<Promise>|Promise} promises
   */
  add(promises) {
    if (!Array.isArray(promises)) promises = [promises];
    
    promises
        // .filter((p) => this.promises.indexOf(p) === -1)
        .forEach((p) => {
          /** @type {Promise} */
          let pr;
          const remove = () => this.promises.splice(this.promises.indexOf(pr), 1);
          pr = p.then(
            (res) => [null, res, remove],
            (err) => [err, null, remove]);
          this.promises.push(pr);
        });
  }

  next() {
    if (this.promises.length === 0) return null;
    return Promise.race(this.promises)
        .then(([err, res, remove]) => {
          remove();
          if (err) throw err;
          return res;
        });
  }
}


/**
 * Simple sha1 hash.
 * @param {Buffer} data The data to hash.
 * @return {Buffer} The sha1 hash.
 */
function sha1(data) {
  return crypto.createHash('sha1').update(data).digest();
};



/**
 * A simple fixed length priority queue, used for DHT navigation.
 * @template T
 */
class PQueue {
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


module.exports = {
  PromiseSelector, sha1, PQueue
};

