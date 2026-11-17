const onboarding = require('../../utils/onboarding');

Component({
  data: { visible: false },
  lifetimes: {
    detached() { onboarding.cancel(this); }
  },
  pageLifetimes: {
    hide() { onboarding.cancel(this); }
  },
  methods: {
    open(ready) { this.setData({ visible: true }, ready); },
    close() { this.setData({ visible: false }); },
    stopTouch() {},
    activate() { onboarding.choose(this, 'activate'); },
    browse() { onboarding.choose(this, 'browse'); }
  }
});
