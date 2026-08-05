const iconIndex = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`;
const iconFilter = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>`;
const iconUpload = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
const iconMy = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;

const makeDataUrl = (svg, color) => {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace('currentColor', color))}`;
};

Component({
  data: {
    selected: 0,
    color: "#9aa39a",
    selectedColor: "#2e7d4f",
    list: [
      {
        pagePath: "/pages/index/index",
        text: "作品墙",
        iconNorm: makeDataUrl(iconIndex, "#9aa39a"),
        iconSel: makeDataUrl(iconIndex, "#2e7d4f")
      },
      {
        pagePath: "/pages/filter/filter",
        text: "筛选",
        iconNorm: makeDataUrl(iconFilter, "#9aa39a"),
        iconSel: makeDataUrl(iconFilter, "#2e7d4f")
      },
      {
        pagePath: "/pages/upload/upload",
        text: "上传",
        iconNorm: makeDataUrl(iconUpload, "#9aa39a"),
        iconSel: makeDataUrl(iconUpload, "#2e7d4f")
      },
      {
        pagePath: "/pages/my/my",
        text: "我的",
        iconNorm: makeDataUrl(iconMy, "#9aa39a"),
        iconSel: makeDataUrl(iconMy, "#2e7d4f")
      }
    ]
  },
  methods: {
    switchTab(e) {
      const data = e.currentTarget.dataset;
      const url = data.path;
      wx.switchTab({ url });
    }
  }
});
