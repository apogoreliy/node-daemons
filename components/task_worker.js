'use strict';

const config = require('../config/config');

const _ = require('lodash');
const Promise = require('bluebird');
const Worker = require('./worker');
const WorkerConst = require('./worker_const');
const models = require('../models');

class TaskWorker extends Worker {

    constructor(name, conf) {
        super(name, conf);
        this.conf = _.defaults({}, this.conf, {
            maxAttempts: WorkerConst.MAX_ATTEMPTS,
            delayRatio: 300000,
            count: 1,
            queue: '',
            update: 10000,
        });
        this.count = 0;
    }

    loop() {
        if (this.count < this.conf.count && !this.stopped) {
            return this.getTask().then(task => {
                if (task) {
                    this.count++;
                    // Touch task
                    const interval = setInterval(() => {
                        return models.sequelize.transaction(t => {
                            return task.check({ transaction: t });
                        });
                    }, this.conf.update);
                    // Handle task
                    Promise.resolve(this.handleTask(task.get({ plain: true }))).then(() => {
                        return models.sequelize.transaction(t => {
                            return task.complete({ transaction: t }).then(() => {
                                this.logger.info('Task completed:', task.id);
                            });
                        });
                    }).catch(err => {
                        this.logger.warn('Handle error:', err);
                        return Promise.resolve(this.delay(task)).then(delay => {
                            return models.sequelize.transaction(t => {
                                return task.fail(delay, { transaction: t }).then(() => {
                                    this.logger.warn('Task failed:', task.id);
                                });
                            });
                        });
                    }).finally(() => {
                        clearInterval(interval);
                        this.count--;
                    }).done();
                }
                return null;
            });
        }
        return null;
    }

    /**
     * @return Promise<any>|any value
     */
    handleTask() {}

    /**
     * @return Promise<int>|int value
     */
    delay(task) {
        return task.attempts * this.conf.delayRatio;
    }

    getTask() {
        return models.sequelize.transaction({ autocommit: false }, t => {
            return models.Task.scope({
                method: ['forWork', this.conf.queue, config.node_id],
            }).find({
                transaction: t,
                lock: t.LOCK.UPDATE,
            }).then(task => {
                return task ? task.work(config.node_id, { transaction: t }) : null;
            });
        });
    }

    startLoop() {
        this.state = WorkerConst.STATE_WORK;
        return Promise.resolve(this.loop()).catch(err => {
            this.logger.warn('Loop error:', err);
        }).finally(() => {
            if (this.count === 0) {
                this.state = WorkerConst.STATE_IDLE;
            }
            if (this.stopped && this.count === 0) {
                this.state = WorkerConst.STATE_STOP;
                this.emit('stop');
            } else {
                this.timer = setTimeout(() => {
                    this.startLoop();
                }, this.conf.sleep);
            }
        });
    }

}

module.exports = TaskWorker;
