const onboarding = require('../../utils/onboarding');

Component({
  data: { visible: false, title: '', body: [], primaryText: '我知道了', secondaryText: '', primaryAction: 'dismiss' },
  lifetimes: {
    detached() { onboarding.cancel(this); }
  },
  pageLifetimes: {
    hide() { onboarding.cancel(this); }
  },
  methods: {
    open(options, ready) {
      const config = options || {};
      const body = Array.isArray(config.body) && config.body.length ? config.body : [config.title || ''];
      this.setData({
        visible: true,
        title: config.title || '公告',
        body,
        primaryText: config.primaryText || '我知道了',
        secondaryText: config.secondaryText || '',
        primaryAction: config.primaryAction === 'activate' ? 'activate' : 'dismiss'
      }, ready);
    },
    close() { this.setData({ visible: false }); },
    stopTouch() {},
    onPrimary() {
      onboarding.choose(this, this.data.primaryAction === 'activate' ? 'activate' : 'browse');
    },
    onSecondary() { onboarding.choose(this, 'browse'); }
  }
});
