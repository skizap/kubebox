'use strict';

const blessed  = require('blessed'),
      chart    = require('./chart'),
      debounce = require('lodash.debounce'),
      duration = require('moment-duration-format'),
      Exec     = require('./exec'),
      get      = require('../http-then').get,
      k8s      = require('../kubernetes'),
      moment   = require('moment'),
      spinner  = require('./spinner'),
      task     = require('../task'),
      util     = require('../util');

const { isNotEmpty, humanBytes, humanCores } = util;

const { delay } = require('../promise');

class Dashboard {

  constructor({ screen, navbar, status, client, debug }) {
    let current_namespace, pod_selected, container_selected, pods_list = [];
    const cancellations = new task.Cancellations();
    const dashboard = this;
    const { until } = spinner(screen);

    const pods_table = blessed.listtable({
      label         : 'Pods',
      parent        : screen,
      left          : 0,
      top           : 1,
      width         : '50%',
      height        : '50%-1',
      border        : 'line',
      align         : 'left',
      keys          : true,
      tags          : true,
      mouse         : true,
      noCellBorders : true,
      scrollbar     : {
        ch    : ' ',
        style : { bg: 'white' },
        track : {
          style : { bg: 'grey' },
        }
      },
      style : {
        label  : { bold: true },
        border : { fg: 'white' },
        header : { fg: 'grey' },
        cell   : { fg: 'white', selected: { bg: 'blue' } },
      }
    });

    const resources = blessed.box({
      label  : 'Resources',
      parent : screen,
      left   : '50%',
      top    : 1,
      right  : 0,
      height : '50%-1',
      tags   : true,
      border : 'line',
      style  : {
        label  : { bold: true },
        border : { fg: 'white' },
        text   : 'white',
      },
    });

    const tabs = blessed.listbar({
      parent : resources,
      top    : 0,
      left   : 1,
      right  : 1,
      height : 'shrink',
      mouse  : true,
      keys   : true,
      style  : {
        bg   : 'white',
        item : {
          fg : 'blue',
          bg : 'white',
          hover : {
            fg : 'white',
            bg : 'lightblue',
          },
        },
        selected : {
          bg: 'blue',
        }
      },
      commands: {
        'Memory': {
          keys     : ['M', 'm'],
          callback : function () {
            graphs.find(g => g.visible).toggle();
            memory_graph.toggle();
          }
        },
        'CPU': {
          keys     : ['C', 'c'],
          callback : function () {
            graphs.find(g => g.visible).toggle();
            cpu_graph.toggle();
          } 
        },
        'Net': {
          keys     : ['T', 't'],
          callback : function () {
            graphs.find(g => g.visible).toggle();
            net_graph.toggle();
          }
        },
      }
    });

    const memory_graph = new chart(resources, { top: 1, abbreviate: humanBytes });
    const cpu_graph = new chart(resources, { top: 1, abbreviate: humanCores });
    const net_graph = new chart(resources, { top: 1 });
    const graphs = [memory_graph, cpu_graph, net_graph];
    graphs.slice(1).forEach(g => g.toggle());

    const pod_log = blessed.log({
      label  : 'Logs',
      top    : '50%',
      bottom : '1',
      align  : 'left',
      tags   : false,
      keys   : true,
      vi     : true,
      mouse  : true,
      border : 'line',
      style  : {
        label  : { bold: true },
        border : { fg: 'white' },
      },
      scrollable : true,
      scrollbar  : {
        ch    : ' ',
        style : { bg: 'white' },
        track : {
          style : { bg: 'grey' },
        }
      },
    });
    pod_log.setScrollPerc(100);

    pod_log.reset = function () {
      this.setLabel('Logs');
      this.clear();
    }

    pods_table.key(['r'], () => {
      // no selection
      if (!pods_table.selected) return;
      const pod = pods_list.items[pods_table.selected - 1];
      // non-running pod
      if (!k8s.isPodRunning(pod)) return;
      const name = pod.metadata.name;
      const namespace = pod.metadata.namespace;
      // FIXME: select which container in pod
      const container = pod.spec.containers[0].name;
      const id = `${namespace}-${name}-${container}`;
      const byId = page => page.id === id;
      // check if connection already exists
      if (navbar.select(byId)) return;

      const exec = new Exec({ screen, status, debug });
      const { promise, _ } = get(client.exec(namespace, name, { container, command: ['/bin/sh', '-c', `TERM=${exec.termName()} sh`] }), { generator: exec.output, readable: exec });

      navbar.add({
        id     : id,
        name   : container,
        render : _ => exec.render(),
      }, { select: true });

      const watch = `terminal.${id}`;
      exec.on('exit', () => {
        cancellations.run(watch);
        navbar.remove(byId);
      });

      until(promise)
        .spin(s => exec.setLabel(`${s} ${namespace}/${name}/${container}`))
        .then(() => debug.log(`{grey-fg}Remote shell into '${namespace}/${name}/${container}'{/grey-fg}`))
        .then(() => exec.setLabel(`${namespace}/${name}/${container}`))
        .then(() => {
          const { promise, cancellation } = get(client.watch_pod(namespace, name, pod.metadata.resourceVersion), { generator: function* () {
            let change;
            while (change = yield) {
              change = JSON.parse(change);
              const pod = change.object;
              switch (change.type) {
                case 'MODIFIED':
                  if (pod.metadata.deletionTimestamp) {
                    exec.setLabel(`${namespace}/${name}/${container} {red-fg}TERMINATING{/red-fg}`);
                    screen.render();
                  }
                  break;
                case 'DELETED':
                  exec.setLabel(`${namespace}/${name}/${container} {red-fg}DELETED{/red-fg}`);
                  screen.render();
                  break;
              }
            }
          }});
          cancellations.add(watch, cancellation);
          return promise;
        })
        // TODO: display error details in terminal
        .catch(error => console.error(error.stack));
    });

    pods_table.on('select', (item, i) => {
      // empty table!
      if (i === 0) return;
      const pod = pods_list.items[i - 1];
      const name = pod.metadata.name;
      const namespace = pod.metadata.namespace;
      const containers = pod.spec.containers;
      let container;
      if (containers.length === 1) {
        if (pod.metadata.uid === pod_selected && container_selected) {
          return;
        } else {
          container = containers[0];
          container_selected = container.name;
        }
      } else if (containers.length > 1) {
        const i = containers.findIndex(c => c.name === container_selected);
        container = containers[(i + 1) % containers.length];
        container_selected = container.name;
      }
      pod_selected = pod.metadata.uid;
      cancellations.run('dashboard.pod');
      // just to update the table with the new selection
      updatePodsTable(pods_list);
      // reset the selected pod widgets
      resources.setLabel('Resources');
      graphs.forEach(g => g.reset());
      pod_log.reset();
      screen.render();

      // non-running pod
      // TODO: display info message in selection widgets
      // Alternatively, we could watch for the pod status and update selection
      // once it's running.
      if (!k8s.isPodRunningOrTerminating(pod)) {
        container_selected = null;
        return;
      }

      const logger = function* (sinceTime) {
        let data, timestamp;
        const lines = [];
        const log = debounce(() => {
          pod_log.log(lines);
          lines.length = 0;
        }, 100, { trailing: true });
        cancellations.add('dashboard.pod.logs', () => log.cancel());
        try {
          while (data = yield) {
            // an initial ping frame with 0-length data is being sent
            if (data.length === 0) continue;
            data = data.toString('utf8');
            data.split(/\r\n|\r|\n/).filter(isNotEmpty).forEach(line => {
              const i = line.indexOf(' ');
              timestamp = line.substring(0, i);
              const l = line.substring(i + 1);
              // avoid scanning the whole buffer if the timestamp differs from the since time
              if (!timestamp.startsWith(sinceTime) || !pod_log._clines.fake.includes(l)) {
                lines.push(l);
                log();
              }
            });
          }
        } catch (e) {
          // HTTP chunked transfer-encoding / streaming requests abort on timeout instead of being ended.
          // WebSocket upgraded requests end when timed out on OpenShift.
        }
        // wait 1s and retry the pod log follow request from the latest timestamp if any
        // TODO: max number of retries per time window
        delay(1000)
          .then(() => get(client.get_pod(namespace, name)))
          .then(response => JSON.parse(response.body.toString('utf8')))
          .then(pod => {
            // selection may have changed
            if (pod.metadata.uid !== pod_selected) return;
            // check if the pod is running
            if (!k8s.isPodRunning(pod)) return;
            // re-follow log from the latest timestamp received
            const { promise, cancellation } = get(client.follow_log(namespace, name, { container: container.name, sinceTime: timestamp }), { generator: timestamp
              ? function* () {
                // sub-second info from the 'sinceTime' parameter are not taken into account
                // so just strip the info and add a 'startsWith' check to avoid duplicates
                yield* logger(timestamp.substring(0, timestamp.indexOf('.')));
              }
              : logger });
            cancellations.add('dashboard.pod.logs', cancellation);
            return promise.then(() => debug.log(`{grey-fg}Following log for ${name}/${container.name} ...{/grey-fg}`));
          })
          .catch(error => {
            // the pod might have already been deleted?
            if (!error.response || error.response.statusCode !== 404) {
              console.error(error.stack);
            }
          });
      };

      const logs = get(client.follow_log(namespace, name, { container: container.name }), { generator: logger });
      cancellations.add('dashboard.pod.logs', logs.cancellation);
      until(logs.promise)
        .spin(s => pod_log.setLabel(`${s} Logs {grey-fg}[${container.name}]{/grey-fg}`))
        .cancel(c => cancellations.add('dashboard.pod.logs', c))
        .then(() => debug.log(`{grey-fg}Following log for ${name}/${container.name} ...{/grey-fg}`))
        .then(() => k8s.isPodTerminating(getPodByUid(pod.metadata.uid))
          ? pod_log.setLabel(`Logs {grey-fg}[${container.name}]{/grey-fg} {red-fg}TERMINATING{/red-fg}`)
          : pod_log.setLabel(`Logs {grey-fg}[${container.name}]{/grey-fg}`))
        .then(() => screen.render())
        .catch(error => console.error(error.stack));

      const stats = updateStatsFromCAdvisor(pod, container);
      cancellations.add('dashboard.pod.stats', stats.cancellation);
      until(stats.promise)
        .spin(s => resources.setLabel(`${s} Resources`))
        .cancel(c => cancellations.add('dashboard.pod.stats', c))
        .then(() => {
          k8s.isPodTerminating(getPodByUid(pod.metadata.uid))
            ? resources.setLabel(`Resources {grey-fg}[${container.name}]{/grey-fg} {red-fg}TERMINATING{/red-fg}`)
            : resources.setLabel(`Resources {grey-fg}[${container.name}]{/grey-fg}`);
          const id = setInterval(pod => {
            const { promise, cancellation } = updateStatsFromCAdvisor(pod, container);
            cancellations.set('dashboard.pod.stats.poll', cancellation);
            promise.catch(error => {
              cancellations.run('dashboard.pod.stats');
              // the pod might have already been deleted?
              if (!error.response || error.response.statusCode !== 404) {
                console.error(error.stack);
              }
            });
          }, 10000, pod);
          cancellations.add('dashboard.pod.stats', () => clearInterval(id));
        })
        .catch(error => {
          resources.setLabel('Resources');
          if (error.response) {
            let message;
            switch (error.response.statusCode) {
              case 403:
                message = 'Resources usage metrics unauthorized';
                break;
              default:
                message = 'Resources usage metrics unavailable';
            }
            graphs.forEach(g => g.message(message));
          } else {
            console.error(error.stack);
          }
        });
    });

    function getPodByUid(uid) {
      return pods_list.items.find(pod => pod.metadata.uid === uid);
    }

    function updatePodsTable(pods) {
      const selected = pods_table.selected;
      pods_table.setData(pods.items.reduce((data, pod) => {
        const uid = pod.metadata.uid;
        data.push([
          uid === pod_selected ? `{blue-fg}${pod.metadata.name}{/blue-fg}` : pod.metadata.name,
          // TODO: add a visual hint depending on the status
          k8s.podStatus(pod),
          // FIXME: negative duration is displayed when pod starts as clocks may not be synced
          util.formatDuration(moment.duration(moment().diff(moment(pod.status.startTime))))
        ]);
        return data;
      }, [['NAME', 'STATUS', 'AGE']]));
      pods_table.select(selected);
    }

    function updateStatsFromCAdvisor(pod, container) {
      let promise, request;
      request = get(client.container_stats(pod.spec.nodeName, pod.metadata.namespace, pod.metadata.name, pod.metadata.uid, container.name), { cancellable: true });
      promise = request.promise
        .then(response => response.body.toString('utf8'))
        .then(response => JSON.parse(response))
        .then(response => {
          const timestamps = response.stats.map(s => moment(s.timestamp).format('HH:mm:ss'));
          // memory
          const memory_cache = {
            title : 'Cache',
            x     : timestamps,
            y     : response.stats.map(s => s.memory.cache),
            style : { line: 'yellow' },
          };
          const memory_usage = {
            title : 'Usage',
            x     : timestamps,
            y     : response.stats.map(s => s.memory.usage),
            style : { line: 'blue' },
          };
          const memory_stats = [memory_usage, memory_cache];
          if (container.resources.limits && container.resources.limits.memory) {
            const memory_limit = {
              title : 'Limit',
              x     : timestamps,
              y     : Array(timestamps.length).fill(response.spec.memory.limit),
              style : { line: 'red' },
            };
            memory_stats.push(memory_limit);
          }
          memory_graph.setData(memory_stats);
          // CPU
          const periods = response.stats.map(s => moment(s.timestamp).format('X')).delta();
          const cpu_user = {
            title : 'User',
            x     : timestamps.slice(1),
            y     : response.stats.map(s => s.cpu.usage.user).delta().map((d, i) => d / 1e+6 / periods[i]),
            style : { line: 'cyan' },
          };
          const cpu_total = {
            title : 'Total',
            x     : timestamps.slice(1),
            y     : response.stats.map(s => s.cpu.usage.total).delta().map((d, i) => d / 1e+6 / periods[i]),
            style : { line: 'blue' },
          };
          const cpu_stats = [cpu_user, cpu_total];
          if (response.spec.cpu.quota) {
            const limit = response.spec.cpu.quota / response.spec.cpu.period * 1e+3;
            const cpu_limit = {
              title : 'Limit',
              x     : timestamps.slice(1),
              y     : Array(timestamps.length - 1).fill(limit),
              style : { line: 'red' },
            };
            cpu_stats.push(cpu_limit);
          }
          cpu_graph.setData(cpu_stats);
          // network
          if (response.spec.has_network) {
            const net_rx = {
              title : 'RX',
              x     : timestamps,
              y     : response.stats.map(s => s.network.rx_bytes),
              style : { line: 'green' },
            };
            const net_tx = {
              title : 'TX',
              x     : timestamps,
              y     : response.stats.map(s => s.network.tx_bytes),
              style : { line: 'cyan' },
            };
            const net_stats = [net_rx, net_tx];
            net_graph.setData(net_stats);
          } else {
            net_graph.message('Network usage unavailable', { bg: 'yellow' });
          }
        });
      return { promise, cancellation: request.cancellation };
    }

    this.render = function () {
      // TODO: restore selection if any
      screen.append(pods_table);
      screen.append(resources);
      screen.append(pod_log);
      pod_log.setScrollPerc(100);
      pods_table.focus();
    }

    this.reset = function () {
      // cancel current running tasks and open requests
      cancellations.run('dashboard');
      current_namespace = null;
      pod_selected = null;
      container_selected = null;
      // reset dashboard widgets
      pods_table.setData([]);
      resources.setLabel('Resources');
      graphs.forEach(g => g.reset());
      pod_log.reset();
      // render
      screen.render();
    }

    // FIXME: handle current namespace deletion nicely
    this.run = function (namespace) {
      current_namespace = namespace;
      // FIXME: should be cancellable
      return until(get(client.get_pods(current_namespace)))
        .spin(s => pods_table.setLabel(`${s} Pods`))
        .succeed(_ =>  pods_table.setLabel('Pods'))
        .then(response => {
          pods_list = JSON.parse(response.body.toString('utf8'));
          pods_list.items = pods_list.items || [];
        })
        .then(() => updatePodsTable(pods_list))
        .then(() => debug.log(`{grey-fg}Watching for pods changes in namespace ${current_namespace} ...{/grey-fg}`))
        .then(() => screen.render())
        .then(() => {
          const id = setInterval(refreshPodAges, 1000);
          cancellations.add('dashboard.refreshPodAges', () => clearInterval(id));
        })
        .then(() => {
          const { promise, cancellation } = get(client.watch_pods(current_namespace, pods_list.metadata.resourceVersion), { generator: updatePodTable });
          cancellations.add('dashboard', cancellation);
          return promise;
        });
    }

    function* updatePodTable() {
      const index = object => pods_list.items.findIndex(pod => pod.metadata.uid === object.metadata.uid);
      let change;
      try {
        while (change = yield) {
          change = JSON.parse(change);
          switch (change.type) {
            case 'ADDED':
              pods_list.items.push(change.object);
              break;
            case 'MODIFIED':
              pods_list.items[index(change.object)] = change.object;
              if (change.object.metadata.uid === pod_selected && k8s.isPodTerminating(change.object) && container_selected) {
                resources.setLabel(`Resources {grey-fg}[${container_selected}]{/grey-fg} {red-fg}TERMINATING{/red-fg}`);
                pod_log.setLabel(`Logs {grey-fg}[${container_selected}]{/grey-fg} {red-fg}TERMINATING{/red-fg}`);
              }
              break;
            case 'DELETED':
              pods_list.items.splice(index(change.object), 1);
              // check if that's the selected pod and clean up
              if (change.object.metadata.uid === pod_selected) {
                cancellations.run('dashboard.pod');
                if (container_selected) {
                  resources.setLabel(`Resources {grey-fg}[${container_selected}]{/grey-fg} {red-fg}DELETED{/red-fg}`);
                  pod_log.setLabel(`Logs {grey-fg}[${container_selected}]{/grey-fg} {red-fg}DELETED{/red-fg}`);
                }
                pod_selected = null;
                container_selected = null;
              }
              break;
          }
          updatePodsTable(pods_list);
          screen.render();
        }
      } catch (e) {
        // HTTP chunked transfer-encoding / streaming watch requests abort on timeout when the 'timeoutSeconds'
        // request parameter is greater than the '--min-request-timeout' server API option,
        // otherwise the connections just end normally (http://kubernetes.io/docs/admin/kube-apiserver/).
        // WebSocket upgraded watch requests (idle?) end when timed out on Kubernetes.
      }
      // retry the pods list watch request
      cancellations.run('dashboard.refreshPodAges');
      dashboard.run(current_namespace).catch(error => console.error(error.stack));
    }

    function refreshPodAges() {
      pods_list.items.forEach(pod => moment(pod.status.startTime).add(1, 's').toISOString());
      // we may want to avoid recreating the whole table data
      updatePodsTable(pods_list);
      screen.render();
    }
  }
}

module.exports = Dashboard;
